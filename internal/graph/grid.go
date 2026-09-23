package graph

import (
	"context"
	"fmt"

	"github.com/neo4j/neo4j-go-driver/v5/neo4j"
	"github.com/neo4j/neo4j-go-driver/v5/neo4j/dbtype"

	"cinedikt/internal/tmdb"
)

// DefaultCastLimit is how many of a film's cast the grid is built from,
// top billing first. Directors are never limited: a film has one or two.
const DefaultCastLimit = 5

// GridPerson is one of the people the grid is built from: a director of
// the searched film, or one of its top-billed cast.
type GridPerson struct {
	ID        int    `json:"id"`
	Name      string `json:"name"`
	Role      string `json:"role"` // "cast" or "director"
	Character string `json:"character,omitempty"`
	Order     int    `json:"order"`
}

// Roles a GridPerson can hold, as the client reads them.
const (
	RoleCast     = "cast"
	RoleDirector = "director"
)

// GridFilm is one card. Rating is nil for a film nobody has rated, which
// the grid shows in its own column rather than dropping.
type GridFilm struct {
	ID       int      `json:"id"`
	Title    string   `json:"title"`
	Year     int      `json:"year"`
	Rating   *float64 `json:"rating"`
	People   []int    `json:"people"`
	IsAnchor bool     `json:"isAnchor"`
}

// GridPayload is everything one grid needs, in one answer.
type GridPayload struct {
	Anchor GridFilm     `json:"anchor"`
	People []GridPerson `json:"people"`
	Films  []GridFilm   `json:"films"`
}

// gridCypher collects the searched film's people and every film they made.
//
// A person's role on the searched film decides which credits count for
// them: a director is followed through DIRECTED, a cast member through
// ACTED_IN. Someone who did both on the searched film appears once, under
// what they did there.
//
// Documentaries are left out. A filmography is full of them — retrospectives,
// making-ofs, festival pieces — and they are a credit rather than a film the
// person made in the sense this grid means.
const gridCypher = `
	MATCH (a:Movie {id: $id})
	CALL (a) {
			MATCH (p:Person)-[:DIRECTED]->(a)
			RETURN p, 'director' AS role, '' AS character, -1 AS ord
		UNION
			MATCH (p:Person)-[r:ACTED_IN]->(a)
			WITH p, r ORDER BY r.order LIMIT $castLimit
			RETURN p, 'cast' AS role, coalesce(r.character, '') AS character, r.order AS ord
	}
	WITH a, p, role, character, ord ORDER BY ord
	WITH a, collect({person: p, role: role, character: character, ord: ord}) AS people
	UNWIND people AS pe
	WITH a, people, pe.person AS maker, pe.role AS makerRole
	CALL (maker, makerRole) {
			WITH maker, makerRole WHERE makerRole = 'director'
			MATCH (maker)-[:DIRECTED]->(f:Movie)
			RETURN f
		UNION
			WITH maker, makerRole WHERE makerRole = 'cast'
			MATCH (maker)-[:ACTED_IN]->(f:Movie)
			RETURN f
	}
	WITH a, people, maker, f
	WHERE f.year IS NOT NULL
	  AND NOT $documentary IN coalesce(f.genres, [])
	WITH a, people, f, collect(DISTINCT maker.id) AS filmPeople
	RETURN a AS anchor, people, collect({film: f, people: filmPeople}) AS films`

// Grid returns the searched film, the people it is built from, and every
// film those people made, in one round trip. castLimit of 0 takes
// DefaultCastLimit.
func (s *Store) Grid(ctx context.Context, movieID, castLimit int) (*GridPayload, error) {
	if castLimit <= 0 {
		castLimit = DefaultCastLimit
	}
	records, err := s.run(ctx, gridCypher, map[string]any{
		"id": movieID, "castLimit": castLimit, "documentary": tmdb.GenreDocumentary,
	})
	if err != nil {
		return nil, fmt.Errorf("graph: grid of movie %d: %w", movieID, err)
	}
	if len(records) == 0 {
		// Either the film is not in the graph or nobody on it has any
		// other credit; a second query is the only way to tell.
		if _, err := s.movie(ctx, movieID); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	rec := records[0]

	anchorNode, err := recordNode(rec, "anchor")
	if err != nil {
		return nil, err
	}
	people, err := gridPeople(rec)
	if err != nil {
		return nil, err
	}
	films, err := gridFilms(rec, movieID)
	if err != nil {
		return nil, err
	}
	anchor := GridFilm{
		ID:       anchorNode.TMDBID,
		Title:    anchorNode.Label,
		Year:     anchorNode.Year,
		Rating:   ratingOf(anchorNode),
		People:   idsOf(people),
		IsAnchor: true,
	}
	// The searched film is one of the cards, and its people are all of
	// them by definition, whether or not the credits happen to say so.
	films = withAnchor(films, anchor)
	return &GridPayload{Anchor: anchor, People: people, Films: films}, nil
}

func gridPeople(rec *neo4j.Record) ([]GridPerson, error) {
	raw, _ := rec.Get("people")
	list, _ := raw.([]any)
	out := make([]GridPerson, 0, len(list))
	for _, item := range list {
		row, _ := item.(map[string]any)
		n, ok := row["person"].(dbtype.Node)
		if !ok {
			return nil, fmt.Errorf("graph: grid person is %T, want Node", row["person"])
		}
		out = append(out, GridPerson{
			ID:        propInt(n.Props, "id"),
			Name:      propString(n.Props, "name"),
			Role:      anyString(row["role"]),
			Character: anyString(row["character"]),
			Order:     anyInt(row["ord"]),
		})
	}
	return out, nil
}

func gridFilms(rec *neo4j.Record, anchorID int) ([]GridFilm, error) {
	raw, _ := rec.Get("films")
	list, _ := raw.([]any)
	out := make([]GridFilm, 0, len(list))
	for _, item := range list {
		row, _ := item.(map[string]any)
		n, ok := row["film"].(dbtype.Node)
		if !ok {
			return nil, fmt.Errorf("graph: grid film is %T, want Node", row["film"])
		}
		node, err := nodeFromDB(n)
		if err != nil {
			return nil, err
		}
		if node.TMDBID == anchorID {
			continue // added separately, with every person on it
		}
		out = append(out, GridFilm{
			ID:     node.TMDBID,
			Title:  node.Label,
			Year:   node.Year,
			Rating: ratingOf(node),
			People: anyInts(row["people"]),
		})
	}
	return out, nil
}

// ratingOf is the figure the map has always shown: IMDb when it is known,
// TMDb otherwise, and nothing at all rather than a zero.
func ratingOf(n Node) *float64 {
	if n.IMDbRating > 0 {
		v := n.IMDbRating
		return &v
	}
	if n.Rating > 0 {
		v := n.Rating
		return &v
	}
	return nil
}

func idsOf(people []GridPerson) []int {
	out := make([]int, 0, len(people))
	for _, p := range people {
		out = append(out, p.ID)
	}
	return out
}

func withAnchor(films []GridFilm, anchor GridFilm) []GridFilm {
	out := make([]GridFilm, 0, len(films)+1)
	out = append(out, anchor)
	return append(out, films...)
}

func anyString(v any) string {
	s, _ := v.(string)
	return s
}

// anyInts reads a Neo4j list of integers.
func anyInts(v any) []int {
	list, _ := v.([]any)
	out := make([]int, 0, len(list))
	for _, item := range list {
		out = append(out, anyInt(item))
	}
	return out
}
