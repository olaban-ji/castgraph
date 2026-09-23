package graph

import (
	"context"
	"errors"
	"fmt"
	"sync"
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

// GridPayload is one screen of a grid, plus whatever was asked for
// around it. People are the whole cast — a chip with no count would be
// a lie — but Films is only the cards the screen asked to see.
type GridPayload struct {
	Anchor GridFilm     `json:"anchor"`
	People []GridPerson `json:"people"`
	Films  []GridFilm   `json:"films"`
	// MoreBefore and MoreAfter are chronological: films that sort earlier,
	// films that sort later. The client decides which of those is up the page.
	MoreBefore bool `json:"moreBefore"`
	MoreAfter  bool `json:"moreAfter"`
}

// How many films one answer may hold. The screen asks for as many rows
// as fit on the glass — one film a row is the tallest that can be — and
// a busier row just means the next request continues where this one
// stopped. The cap is a very tall monitor, not a career.
const (
	DefaultGridLimit = 12
	MaxGridLimit     = 80
)

// GridQuery is the slice of a grid the screen can show. Limit is a count
// of films, not years. Before asks for films that sort strictly before
// that film, After for films that sort strictly after, and neither
// centers Limit on the searched film.
type GridQuery struct {
	CastLimit int
	Limit     int
	Before    int
	After     int
	// HideUnrated drops films nobody has rated. It is a column on the
	// plot, so taking it away is a change to the shape of the grid.
	//
	// There is deliberately no rating floor here. A floor decides what is
	// *lit*, not what exists: the grid's argument is where a film sits on
	// the scale, and a film that left the page cannot make it. The client
	// dims, and the server never has to page around a moving predicate.
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

// gridPageCypher returns films on one side of a cursor, nearest first.
// dir is "before" or "after". The searched film is left out: the first
// screen adds it itself, and a later page already has it.
func gridPageCypher(dir string) string {
	op, order := ">", "ASC"
	if dir == "before" {
		op, order = "<", "DESC"
	}
	shown := shownRating("f")
	rated := `CASE WHEN shown > 0 THEN 1 ELSE 0 END`
	cursor := `f.year ` + op + ` $cYear
	   OR (f.year = $cYear AND ` + rated + ` ` + op + ` $cRated)
	   OR (f.year = $cYear AND ` + rated + ` = $cRated AND shown ` + op + ` $cRating)
	   OR (f.year = $cYear AND ` + rated + ` = $cRated AND shown = $cRating AND coalesce(f.title, '') ` + op + ` $cTitle)
	   OR (f.year = $cYear AND ` + rated + ` = $cRated AND shown = $cRating AND coalesce(f.title, '') = $cTitle AND f.id ` + op + ` $cId)`
	orderBy := `f.year ` + order + `, ` + rated + ` ` + order + `, shown ` + order + `, coalesce(f.title, '') ` + order + `, f.id ` + order
	pred := filmPred("f") + ` AND f.id <> $skip`
	// Each person only yields as many films as the screen asked for.
	// A career walk, then a LIMIT, is how a first request spent seconds.
	return `
	UNWIND $people AS pe
	MATCH (maker:Person {id: pe.id})
	WITH maker, pe.role AS makerRole
	CALL (maker, makerRole) {
			WITH maker, makerRole WHERE makerRole = 'director'
			MATCH (maker)-[:DIRECTED]->(f:Movie)
			WHERE ` + pred + `
			WITH f, ` + shown + ` AS shown
			WHERE ` + cursor + `
			RETURN f, shown
			ORDER BY ` + orderBy + `
			LIMIT $fetch
		UNION
			WITH maker, makerRole WHERE makerRole = 'cast'
			MATCH (maker)-[:ACTED_IN]->(f:Movie)
			WHERE ` + pred + `
			WITH f, ` + shown + ` AS shown
			WHERE ` + cursor + `
			RETURN f, shown
			ORDER BY ` + orderBy + `
			LIMIT $fetch
	}
	WITH f, shown, collect(DISTINCT maker.id) AS filmPeople
	ORDER BY ` + orderBy + `
	LIMIT $fetch
	RETURN f AS film, filmPeople AS people`
}

// Grid returns the searched film, the people it is built from, and the
// films that fit the screen q asks for. A cast limit of AllCast takes
// the whole cast. Films past that screen stay where they are until the
// next request; the flags say whether that request would find any.
func (s *Store) Grid(ctx context.Context, movieID int, q GridQuery) (*GridPayload, error) {
	if q.CastLimit <= AllCast {
		q.CastLimit = castCeiling
	}
	if q.Limit < 1 {
		q.Limit = DefaultGridLimit
	}
	if q.Limit > MaxGridLimit {
		q.Limit = MaxGridLimit
	}
	params := map[string]any{
		"id": movieID, "castLimit": q.CastLimit, "documentary": tmdb.GenreDocumentary,
		"today": s.now().Format(time.DateOnly), "hideUnrated": q.HideUnrated,
	}
	records, err := s.run(ctx, gridSpineCypher, params)
	if err != nil {
		return nil, fmt.Errorf("graph: grid of movie %d: %w", movieID, err)
	}
	if len(records) == 0 {
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
	// Count is already on each person from the spine.
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
	var films []GridFilm
	var moreBefore, moreAfter bool
	switch {
	case q.Before > 0:
		films, moreBefore, err = s.filmsFrom(ctx, params, people, q.Before, q.Limit, "before")
	case q.After > 0:
		films, moreAfter, err = s.filmsFrom(ctx, params, people, q.After, q.Limit, "after")
	default:
		films, moreBefore, moreAfter, err = s.filmsAround(ctx, params, people, anchorNode, q.Limit)
		films = withAnchor(films, anchor)
	}
	if err != nil {
		return nil, err
	}
	return &GridPayload{
		Anchor: anchor, People: people, Films: films,
		MoreBefore: moreBefore, MoreAfter: moreAfter,
	}, nil
}

// filmsAround returns the films on either side of the searched one, up
// to limit cards including it. A career that runs out on one side fills
// the screen from the other.
func (s *Store) filmsAround(ctx context.Context, params map[string]any, people []GridPerson, anchor Node, limit int) ([]GridFilm, bool, bool, error) {
	// One past the most this screen can take, so the flag is honest.
	fetch := limit + 1
	var before, after []GridFilm
	var errBefore, errAfter error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		before, errBefore = s.page(ctx, params, people, anchor, anchor.TMDBID, fetch, "before")
	}()
	go func() {
		defer wg.Done()
		after, errAfter = s.page(ctx, params, people, anchor, anchor.TMDBID, fetch, "after")
	}()
	wg.Wait()
	if errBefore != nil {
		return nil, false, false, errBefore
	}
	if errAfter != nil {
		return nil, false, false, errAfter
	}
	takeBefore, takeAfter, moreBefore, moreAfter := centerWindow(len(before), len(after), limit)
	films := append([]GridFilm{}, before[:takeBefore]...)
	return append(films, after[:takeAfter]...), moreBefore, moreAfter, nil
}

// filmsFrom returns the next page strictly on one side of a film the
// reader already has. A missing cursor is an empty page, not an error:
// the screen stops asking.
func (s *Store) filmsFrom(ctx context.Context, params map[string]any, people []GridPerson, cursorID, limit int, dir string) ([]GridFilm, bool, error) {
	cursor, err := s.movie(ctx, cursorID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, false, nil
		}
		return nil, false, err
	}
	got, err := s.page(ctx, params, people, cursor, 0, limit+1, dir)
	if err != nil {
		return nil, false, err
	}
	keep, more := pageWindow(len(got), limit)
	return got[:keep], more, nil
}

func (s *Store) page(ctx context.Context, params map[string]any, people []GridPerson, cursor Node, skip, fetch int, dir string) ([]GridFilm, error) {
	rawPeople := make([]map[string]any, 0, len(people))
	for _, p := range people {
		rawPeople = append(rawPeople, map[string]any{"id": p.ID, "role": p.Role})
	}
	q := make(map[string]any, len(params)+8)
	for k, v := range params {
		q[k] = v
	}
	rating := 0.0
	rated := 0
	if r := ratingOf(cursor); r != nil {
		rating = *r
		rated = 1
	}
	q["people"] = rawPeople
	q["skip"] = skip
	q["fetch"] = fetch
	q["cYear"] = cursor.Year
	q["cRated"] = rated
	q["cRating"] = rating
	q["cTitle"] = cursor.Label
	q["cId"] = cursor.TMDBID
	records, err := s.run(ctx, gridPageCypher(dir), q)
	if err != nil {
		return nil, fmt.Errorf("graph: grid films: %w", err)
	}
	out := make([]GridFilm, 0, len(records))
	for _, rec := range records {
		film, err := oneFilm(rec)
		if err != nil {
			return nil, err
		}
		if film.ID == 0 {
			continue
		}
		out = append(out, film)
	}
	return out, nil
}

// centerWindow decides how many films to keep on each side of the
// searched one. nBefore and nAfter are how many were found, which may
// be one more than the screen can hold. The searched film uses one slot.
func centerWindow(nBefore, nAfter, limit int) (takeBefore, takeAfter int, moreBefore, moreAfter bool) {
	if limit < 1 {
		limit = 1
	}
	spare := limit - 1
	takeBefore = spare / 2
	takeAfter = spare - takeBefore
	if takeBefore > nBefore {
		takeAfter += takeBefore - nBefore
		takeBefore = nBefore
	}
	if takeAfter > nAfter {
		takeBefore += takeAfter - nAfter
		if takeBefore > nBefore {
			takeBefore = nBefore
		}
		takeAfter = nAfter
	}
	return takeBefore, takeAfter, nBefore > takeBefore, nAfter > takeAfter
}

// pageWindow keeps a page of films and reports whether the fetch saw one
// more past it.
func pageWindow(n, limit int) (keep int, more bool) {
	if n > limit {
		return limit, true
	}
	return n, false
}

func value(rec *neo4j.Record, key string) any {
	v, _ := rec.Get(key)
	return v
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
