package graph

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/neo4j/neo4j-go-driver/v5/neo4j"
	"github.com/neo4j/neo4j-go-driver/v5/neo4j/dbtype"

	"cinedikt/internal/tmdb"
)

// AllCast is the cast limit meaning "everyone". The grid is built from a
// film's whole cast and every one of its directors: a limit picked by
// billing cut Joe Pantoliano — 105 other films — out of The Matrix to
// keep the Oracle's 16, which is not a judgement the map should be making
// on the reader's behalf.
const AllCast = 0

// castCeiling bounds the query when no limit is asked for. Cypher needs a
// number for LIMIT, and no film has a credited cast anywhere near this.
const castCeiling = 10000

// GridPerson is one of the people the grid is built from: a director of
// the searched film, or one of its top-billed cast.
type GridPerson struct {
	ID        int    `json:"id"`
	Name      string `json:"name"`
	Role      string `json:"role"` // "cast" or "director"
	Character string `json:"character,omitempty"`
	Order     int    `json:"order"`
	// Count is how many of this person's films belong on the grid, the
	// whole career so far, not just the cards in this answer.
	Count int `json:"count"`
}

// Roles a GridPerson can hold, as the client reads them.
const (
	RoleCast     = "cast"
	RoleDirector = "director"
)

// GridFilm is one card. Rating is nil for a film nobody has rated, which
// the grid shows in its own column rather than dropping.
type GridFilm struct {
	ID    int    `json:"id"`
	Title string `json:"title"`
	Year  int    `json:"year"`
	// Released is YYYY-MM-DD. The year band stacks by month and day
	// without labelling them; this is the only date the client has.
	Released string   `json:"released,omitempty"`
	Rating   *float64 `json:"rating"`
	Poster   string   `json:"poster,omitempty"`
	People   []int    `json:"people"`
	IsAnchor bool     `json:"isAnchor"`
}

// SpineFilm is where a card goes: the three facts that decide its place,
// and nothing else. The whole spine is sent at once, so the layout is
// final from the first paint and no card ever moves again — which is the
// only way to stop a later page shoving the rows below it down the page.
//
// It travels as [id, year, rating] rather than an object: over a few
// hundred films the key names are most of the bytes.
type SpineFilm struct {
	ID     int
	Year   int
	Rating *float64
	// MD is the month and day as MMDD, or 0 when the date says only a
	// year. Cards stacked in one year sit in calendar order, and that is
	// all the ordering needs — the year is already the row.
	MD int
}

func (f SpineFilm) MarshalJSON() ([]byte, error) {
	return json.Marshal([4]any{f.ID, f.Year, f.Rating, f.MD})
}

// monthDay reads MMDD out of a YYYY-MM-DD release date. A date that says
// only a year gives 0, which sorts to the head of its year.
func monthDay(released string) int {
	if len(released) < 7 {
		return 0
	}
	mo, err := strconv.Atoi(released[5:7])
	if err != nil || mo < 1 || mo > 12 {
		return 0
	}
	day := 1
	if len(released) >= 10 {
		if d, err := strconv.Atoi(released[8:10]); err == nil && d >= 1 && d <= 31 {
			day = d
		}
	}
	return mo*100 + day
}

// GridPayload is the spine of one grid: the searched film, the people it
// is built from, and the place of every card. What a card *says* — its
// title, poster and people — arrives a screen at a time through
// GridFilms, into a box that already exists.
type GridPayload struct {
	Anchor GridFilm     `json:"anchor"`
	People []GridPerson `json:"people"`
	Films  []SpineFilm  `json:"films"`
}

// MaxGridFilms bounds one detail request. A screen holds a few dozen
// cards; this is a wide monitor with the rows packed, not a career.
const MaxGridFilms = 200

// GridQuery is what the whole grid is built from.
type GridQuery struct {
	CastLimit int
	// HideUnrated drops films nobody has rated. It is a column on the
	// plot, so taking it away is a change to the shape of the grid.
	//
	// There is deliberately no rating floor here. A floor decides what is
	// *lit*, not what exists: the grid's argument is where a film sits on
	// the scale, and a film that left the page cannot make it. The client
	// dims, and the spine is the same set either way.
	HideUnrated bool
}

// A film earns a place on the grid by having a release date that has
// arrived, and by not being a documentary. The rating the card shows —
// IMDb when it is known, TMDb otherwise — is the same test the client
// uses to drop what the reader asked not to see.
func filmPred(name string) string {
	return fmt.Sprintf(`%[1]s.year IS NOT NULL
		  AND %[1]s.release_date IS NOT NULL AND %[1]s.release_date <> '' AND %[1]s.release_date <= $today
		  AND NOT $documentary IN coalesce(%[1]s.genres, [])
		  AND (NOT $hideUnrated OR (CASE WHEN coalesce(%[1]s.imdb_rating, 0) > 0 THEN %[1]s.imdb_rating ELSE coalesce(%[1]s.rating, 0) END) > 0)`, name)
}

// gridSpineCypher reads the people and how many films each one has on
// the grid. It does not return the films: a career is wider than a
// screen, and the cards themselves are a second, limited query.
// gridSpineCypher is the searched film and its people. Counts are a
// degree lookup, not a walk of every film: the first screen cannot
// wait for that.
var gridSpineCypher = `
	MATCH (a:Movie {id: $id})
	CALL (a) {
			MATCH (p:Person)-[:DIRECTED]->(a)
			RETURN p, 'director' AS role, '' AS character, -1 AS ord
		UNION
			MATCH (p:Person)-[r:ACTED_IN]->(a)
			WITH p, r ORDER BY r.order LIMIT $castLimit
			RETURN p, 'cast' AS role, coalesce(r.character, '') AS character, r.order AS ord
	}
	WITH a, p, role, character, ord,
	     CASE role
	       WHEN 'director' THEN COUNT { (p)-[:DIRECTED]->(:Movie) }
	       ELSE COUNT { (p)-[:ACTED_IN]->(:Movie) }
	     END AS hits
	ORDER BY ord
	WITH a, collect({person: p, role: role, character: character, ord: ord, hits: hits}) AS people
	RETURN a AS anchor, people`

// The rating a card shows, and 0 when nobody has rated the film. The
// same figure orders the page, so a later request can continue from the
// last film instead of from a year.
func shownRating(name string) string {
	return fmt.Sprintf(`CASE WHEN coalesce(%[1]s.imdb_rating, 0) > 0 THEN %[1]s.imdb_rating ELSE coalesce(%[1]s.rating, 0) END`, name)
}

// gridFilmsCypher is the spine: every film the grid holds, as the three
// facts that place it. No cursor and no limit — the point is that the
// client learns the whole shape at once and never has to move a card.
func gridFilmsCypher() string {
	shown := shownRating("f")
	pred := filmPred("f")
	return `
	UNWIND $people AS pe
	MATCH (maker:Person {id: pe.id})
	WITH maker, pe.role AS makerRole
	CALL (maker, makerRole) {
			WITH maker, makerRole WHERE makerRole = 'director'
			MATCH (maker)-[:DIRECTED]->(f:Movie)
			WHERE ` + pred + `
			RETURN f
		UNION
			WITH maker, makerRole WHERE makerRole = 'cast'
			MATCH (maker)-[:ACTED_IN]->(f:Movie)
			WHERE ` + pred + `
			RETURN f
	}
	WITH DISTINCT f
	RETURN f.id AS id, f.year AS year, ` + shown + ` AS rating, coalesce(f.release_date, '') AS released`
}

// gridDetailCypher is the flesh: what the cards in front of the reader
// actually say. It is asked for by id, because the client already knows
// from the spine which cards those are.
func gridDetailCypher() string {
	return `
	UNWIND $ids AS wanted
	MATCH (f:Movie {id: wanted})
	CALL (f) {
		UNWIND $people AS pe
		MATCH (p:Person {id: pe.id})
		WITH p, pe, f
		WHERE (pe.role = 'director' AND EXISTS { (p)-[:DIRECTED]->(f) })
		   OR (pe.role = 'cast' AND EXISTS { (p)-[:ACTED_IN]->(f) })
		RETURN collect(p.id) AS filmPeople
	}
	RETURN f AS film, filmPeople AS people`
}

// Grid returns the spine: the searched film, the people it is built
// from, and where every card goes. A cast limit of AllCast takes the
// whole cast.
func (s *Store) Grid(ctx context.Context, movieID int, q GridQuery) (*GridPayload, error) {
	if q.CastLimit <= AllCast {
		q.CastLimit = castCeiling
	}
	params := map[string]any{
		"id": movieID, "castLimit": q.CastLimit, "documentary": tmdb.GenreDocumentary,
		"today": s.now().Format(time.DateOnly), "hideUnrated": q.HideUnrated,
	}
	anchorNode, people, err := s.gridPeople(ctx, movieID, params)
	if err != nil {
		return nil, err
	}
	anchor := GridFilm{
		ID:       anchorNode.TMDBID,
		Title:    anchorNode.Label,
		Year:     anchorNode.Year,
		Released: anchorNode.Released,
		Rating:   ratingOf(anchorNode),
		Poster:   anchorNode.Poster,
		People:   idsOf(people),
		IsAnchor: true,
	}
	films, err := s.spineFilms(ctx, params, people)
	if err != nil {
		return nil, err
	}
	return &GridPayload{Anchor: anchor, People: people, Films: films}, nil
}

// GridFilms is what the cards in front of the reader say: title, poster,
// date, and which of the searched film's people are in them. The client
// asks by id, because the spine already told it which ids those are.
func (s *Store) GridFilms(ctx context.Context, movieID int, ids []int) ([]GridFilm, error) {
	if len(ids) == 0 {
		return []GridFilm{}, nil
	}
	if len(ids) > MaxGridFilms {
		ids = ids[:MaxGridFilms]
	}
	params := map[string]any{
		"id": movieID, "castLimit": castCeiling, "documentary": tmdb.GenreDocumentary,
		"today": s.now().Format(time.DateOnly), "hideUnrated": false,
	}
	_, people, err := s.gridPeople(ctx, movieID, params)
	if err != nil {
		return nil, err
	}
	records, err := s.run(ctx, gridDetailCypher(), map[string]any{
		"ids": ids, "people": peopleParams(people),
	})
	if err != nil {
		return nil, fmt.Errorf("graph: grid films of movie %d: %w", movieID, err)
	}
	out := make([]GridFilm, 0, len(records))
	for _, rec := range records {
		film, err := oneFilm(rec)
		if err != nil {
			return nil, err
		}
		film.IsAnchor = film.ID == movieID
		out = append(out, film)
	}
	return out, nil
}

// gridPeople reads the searched film and the people the grid is built
// from. Both queries need it, and neither can start without it.
func (s *Store) gridPeople(ctx context.Context, movieID int, params map[string]any) (Node, []GridPerson, error) {
	records, err := s.run(ctx, gridSpineCypher, params)
	if err != nil {
		return Node{}, nil, fmt.Errorf("graph: grid of movie %d: %w", movieID, err)
	}
	if len(records) == 0 {
		if _, err := s.movie(ctx, movieID); err != nil {
			return Node{}, nil, err
		}
		return Node{}, nil, ErrNotFound
	}
	anchor, err := recordNode(records[0], "anchor")
	if err != nil {
		return Node{}, nil, err
	}
	people, err := peopleFromRecord(records[0])
	if err != nil {
		return Node{}, nil, err
	}
	return anchor, people, nil
}

// spineFilms reads where every card goes, searched film included.
func (s *Store) spineFilms(ctx context.Context, params map[string]any, people []GridPerson) ([]SpineFilm, error) {
	q := make(map[string]any, len(params)+1)
	for k, v := range params {
		q[k] = v
	}
	q["people"] = peopleParams(people)
	records, err := s.run(ctx, gridFilmsCypher(), q)
	if err != nil {
		return nil, fmt.Errorf("graph: grid spine: %w", err)
	}
	out := make([]SpineFilm, 0, len(records))
	for _, rec := range records {
		f := SpineFilm{
			ID:   anyInt(value(rec, "id")),
			Year: anyInt(value(rec, "year")),
			MD:   monthDay(anyString(value(rec, "released"))),
		}
		if r := anyFloat(value(rec, "rating")); r > 0 {
			f.Rating = &r
		}
		out = append(out, f)
	}
	return out, nil
}

func peopleFromRecord(rec *neo4j.Record) ([]GridPerson, error) {
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
			Count:     anyInt(row["hits"]),
		})
	}
	return out, nil
}

func oneFilm(rec *neo4j.Record) (GridFilm, error) {
	n, err := recordNode(rec, "film")
	if err != nil {
		return GridFilm{}, err
	}
	return GridFilm{
		ID:       n.TMDBID,
		Title:    n.Label,
		Year:     n.Year,
		Released: n.Released,
		Rating:   ratingOf(n),
		Poster:   n.Poster,
		People:   anyInts(value(rec, "people")),
	}, nil
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

// peopleParams is the people list as Cypher wants it: id and the role
// that decides which of their credits count.
func peopleParams(people []GridPerson) []map[string]any {
	out := make([]map[string]any, 0, len(people))
	for _, p := range people {
		out = append(out, map[string]any{"id": p.ID, "role": p.Role})
	}
	return out
}

func value(rec *neo4j.Record, key string) any {
	v, _ := rec.Get(key)
	return v
}

// anyFloat reads a Neo4j number, which may arrive as either kind.
func anyFloat(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int64:
		return float64(n)
	case int:
		return float64(n)
	}
	return 0
}
