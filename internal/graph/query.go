package graph

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/neo4j/neo4j-go-driver/v5/neo4j"
	"github.com/neo4j/neo4j-go-driver/v5/neo4j/dbtype"
)

// ErrNotFound is returned when the requested node is not in the graph.
var ErrNotFound = errors.New("graph: not found")

// MovieCrawled reports whether a movie's own cast and directors have been
// fetched. A movie known only as an entry in someone's filmography has
// not been. Movies crawled before directors were stored look crawled but
// return false so the next request backfills them.
//
// The rest of the cast can still be missing a filmography. The first
// screen does not wait for those: it answers with the films already
// written, and the remaining people are fetched behind it.
func (s *Store) MovieCrawled(ctx context.Context, movieID int) (bool, error) {
	records, err := s.run(ctx,
		`MATCH (m:Movie {id: $id})
		 RETURN m.crawled_at IS NOT NULL AND (
		   coalesce(m.directors_crawled, false)
		   OR EXISTS { MATCH (:Person)-[:DIRECTED]->(m) }
		 ) AS crawled`,
		map[string]any{"id": movieID})
	if err != nil {
		return false, fmt.Errorf("graph: movie %d crawled: %w", movieID, err)
	}
	if len(records) == 0 {
		return false, nil
	}
	crawled, _ := records[0].Get("crawled")
	return crawled == true, nil
}

// GridReady is true when the movie is written and at least one person
// on it has been looked at. That is one existence check, not a walk of
// every film they made — the first screen cannot wait on that walk.
func (s *Store) GridReady(ctx context.Context, movieID, _ int) (bool, error) {
	records, err := s.run(ctx,
		`MATCH (m:Movie {id: $id})
		 WHERE m.crawled_at IS NOT NULL AND (
		   coalesce(m.directors_crawled, false)
		   OR EXISTS { MATCH (:Person)-[:DIRECTED]->(m) }
		 )
		 RETURN EXISTS {
		   MATCH (p:Person)-[:ACTED_IN|DIRECTED]->(m)
		   WHERE p.filmography_at IS NOT NULL
		 } OR NOT EXISTS {
		   MATCH (q:Person)-[:ACTED_IN]->(m)
		   WHERE q.filmography_at IS NULL
		 } AS ready`,
		map[string]any{"id": movieID})
	if err != nil {
		return false, fmt.Errorf("graph: movie %d grid-ready: %w", movieID, err)
	}
	if len(records) == 0 {
		return false, nil
	}
	ready, _ := records[0].Get("ready")
	return ready == true, nil
}

// UnexpandedCast is the people on a movie whose filmography has never
// been fetched. The first screen does not wait for them.
func (s *Store) UnexpandedCast(ctx context.Context, movieID int) ([]int, error) {
	records, err := s.run(ctx,
		`MATCH (p:Person)-[:ACTED_IN|DIRECTED]->(m:Movie {id: $id})
		 WHERE p.filmography_at IS NULL
		 RETURN DISTINCT p.id AS id`,
		map[string]any{"id": movieID})
	if err != nil {
		return nil, fmt.Errorf("graph: movie %d unexpanded cast: %w", movieID, err)
	}
	out := make([]int, 0, len(records))
	for _, rec := range records {
		if id := anyInt(value(rec, "id")); id != 0 {
			out = append(out, id)
		}
	}
	return out, nil
}

// MovieMeta is a movie's title and year, for the link preview a scraper
// reads before anyone opens the page. It only reads: a movie the graph
// has never seen returns ErrNotFound rather than being crawled, because
// nothing a share card says is worth making a stranger's paste wait.
//
// The year is 0 when the graph does not have one.
func (s *Store) MovieMeta(ctx context.Context, id int) (string, int, error) {
	n, err := s.movie(ctx, id)
	if err != nil {
		return "", 0, err
	}
	return n.Label, n.Year, nil
}

func (s *Store) movie(ctx context.Context, id int) (Node, error) {
	records, err := s.run(ctx, `MATCH (n:Movie {id: $id}) RETURN n`, map[string]any{"id": id})
	if err != nil {
		return Node{}, fmt.Errorf("graph: load movie %d: %w", id, err)
	}
	if len(records) == 0 {
		return Node{}, fmt.Errorf("graph: movie %d: %w", id, ErrNotFound)
	}
	return recordNode(records[0], "n")
}

func recordNode(rec *neo4j.Record, column string) (Node, error) {
	v, ok := rec.Get(column)
	if !ok {
		return Node{}, fmt.Errorf("graph: record has no %s column", column)
	}
	n, ok := v.(dbtype.Node)
	if !ok {
		return Node{}, fmt.Errorf("graph: %s column is %T, want Node", column, v)
	}
	return nodeFromDB(n)
}

func nodeFromDB(n dbtype.Node) (Node, error) {
	id := propInt(n.Props, "id")
	for _, label := range n.Labels {
		switch label {
		case "Movie":
			return Node{
				ID:       MovieNodeID(id),
				Type:     KindMovie,
				Label:    propString(n.Props, "title"),
				TMDBID:   id,
				Year:     propInt(n.Props, "year"),
				Released: propString(n.Props, "release_date"),
				Poster:   PosterURL(propString(n.Props, "poster_path")),
				Backdrop: BackdropURL(propString(n.Props, "backdrop_path")),
				Rating:   propFloat(n.Props, "rating"),
				Votes:    propInt(n.Props, "vote_count"),
				IMDbID:   propString(n.Props, "imdb_id"),

				IMDbRating: propFloat(n.Props, "imdb_rating"),
				IMDbVotes:  propInt(n.Props, "imdb_votes"),
			}, nil
		case "Person":
			return Node{
				ID:         PersonNodeID(id),
				Type:       KindPerson,
				Label:      propString(n.Props, "name"),
				TMDBID:     id,
				Popularity: propFloat(n.Props, "popularity"),
			}, nil
		}
	}
	return Node{}, fmt.Errorf("graph: node %d has labels %v, want Movie or Person", id, n.Labels)
}

func propString(props map[string]any, key string) string {
	s, _ := props[key].(string)
	return s
}

func propFloat(props map[string]any, key string) float64 {
	switch v := props[key].(type) {
	case float64:
		return v
	case int64:
		return float64(v)
	}
	return 0
}

func propInt(props map[string]any, key string) int { return anyInt(props[key]) }

// anyInt reads a Neo4j integer, which arrives as int64 but may be a float
// after arithmetic in Cypher.
func anyInt(v any) int {
	switch t := v.(type) {
	case int64:
		return int(t)
	case int:
		return t
	case float64:
		return int(t)
	}
	return 0
}

func relRole(r dbtype.Relationship) string {
	if s := propString(r.Props, "character"); s != "" {
		return s
	}
	return propString(r.Props, "job")
}

// PathwayFilm is a film in a pathway with the connecting person's role in it.
type PathwayFilm struct {
	Node
	Role  string `json:"role"`
	Order int    `json:"order"`
}

// Pathway is one person connected to a movie together with their most
// voted other films: what the map needs to grow branches from a stop, and
// nothing more. Role is the character name for actors and "Director" for
// directors.
type Pathway struct {
	Person Node          `json:"person"`
	Role   string        `json:"role"`
	Order  int           `json:"order"`
	Films  []PathwayFilm `json:"films"`
}

// Pathways is the lean expansion of one movie.
type Pathways struct {
	Movie Node      `json:"movie"`
	Cast  []Pathway `json:"cast"`
}

// PathwayFilter narrows a pathway to connections a viewer would recognise.
// Zero values mean no limit.
type PathwayFilter struct {
	// MaxBilling keeps only cast members billed at or above this position
	// in the movie, and only their films where they are billed likewise.
	MaxBilling int
	// MinVotes keeps only films with at least this many TMDb votes.
	MinVotes int
	// PersonID narrows the whole pathway to one person, so a reader who
	// has asked to see one career is answered with that career rather
	// than the slice of it a map happened to grow. Zero means everyone.
	PersonID int
}

// maxDirectorPathways caps how many directors of one film become hops.
// Features have one; a handful of films have two or three.
const maxDirectorPathways = 4

// A film's vote count is what the map ranks by, but a vote count is
// accumulated attention, so it mostly measures age: a 2025 release cannot
// out-vote a 1997 one, and a star's new film is ranked off the map behind
// their back catalogue. Rather than reweigh the ranking, which would cost
// an older film its place, a person gets recentSlots extra films that
// only their newest work can fill. The vote floor still reads the raw
// count, so an obscure new film cannot take a slot either.
//
// Three slots because recent work is not evenly spread: of the people on
// a map with any, 73% have one film, 16% two and 7% three, so three slots
// carry 95% of it. The rest is a thin tail of the very prolific — Pedro
// Pascal has eight — and letting that tail through would put one person's
// year on the map at the expense of everyone else's.
const (
	recentYears = 2
	recentSlots = 3
)

// recentFrom is the release year from which a film counts as recent.
// Taken from the clock, so the window moves with it.
func recentFrom(now time.Time) int { return now.Year() - recentYears }

// Kinds of pathway as the query tags them.
const (
	kindActor    = 0
	kindDirector = 1
)

// pathwaysCypher collects a movie's hops in one round trip: its top-billed
// cast and its directors, each with their most voted other films and,
// beside them, their newest. The branches are a UNION rather than
// separate queries because a pathways request is the map's hot path and
// every round trip is latency a reader feels.
var pathwaysCypher = fmt.Sprintf(pathwaysCypherFmt,
	kindActor, kindDirector, // who the hops are
	kindActor, kindActor, kindDirector, kindDirector) // their films, then their newest

const pathwaysCypherFmt = `
	MATCH (m:Movie {id: $id})
	CALL (m) {
			MATCH (p:Person)-[r:ACTED_IN]->(m)
			WHERE ($person = 0 OR p.id = $person)
			  AND ($billing = 0 OR r.order <= $billing)
			  AND EXISTS {
				(p)-[r2:ACTED_IN]->(o:Movie)
				WHERE o <> m AND o.year IS NOT NULL
				  AND ($billing = 0 OR r2.order <= $billing)
				  AND coalesce(o.vote_count, 0) >= $minVotes
			  }
			WITH p, r ORDER BY r.order LIMIT $costars
			RETURN p AS person, r AS rel, %d AS kind
		UNION
			MATCH (p:Person)-[r:DIRECTED]->(m)
			WHERE ($person = 0 OR p.id = $person)
			  AND EXISTS {
				(p)-[:DIRECTED]->(o:Movie)
				WHERE o <> m AND o.year IS NOT NULL
				  AND coalesce(o.vote_count, 0) >= $minVotes
			  }
			WITH p, r ORDER BY p.popularity DESC LIMIT $directors
			RETURN p AS person, r AS rel, %d AS kind
	}
	CALL (person, m, kind) {
			WITH person, m, kind WHERE kind = %d
			MATCH (person)-[r2:ACTED_IN]->(o:Movie)
			WHERE o <> m AND o.year IS NOT NULL
			  AND ($billing = 0 OR r2.order <= $billing)
			  AND coalesce(o.vote_count, 0) >= $minVotes
			RETURN o, r2 ORDER BY o.vote_count DESC LIMIT $films
		UNION
			WITH person, m, kind WHERE kind = %d
			MATCH (person)-[r2:ACTED_IN]->(o:Movie)
			WHERE o <> m AND o.year >= $recentFrom
			  AND ($billing = 0 OR r2.order <= $billing)
			  AND coalesce(o.vote_count, 0) >= $minVotes
			RETURN o, r2 ORDER BY o.vote_count DESC LIMIT $recentSlots
		UNION
			WITH person, m, kind WHERE kind = %d
			MATCH (person)-[r2:DIRECTED]->(o:Movie)
			WHERE o <> m AND o.year IS NOT NULL
			  AND coalesce(o.vote_count, 0) >= $minVotes
			RETURN o, r2 ORDER BY o.vote_count DESC LIMIT $films
		UNION
			WITH person, m, kind WHERE kind = %d
			MATCH (person)-[r2:DIRECTED]->(o:Movie)
			WHERE o <> m AND o.year >= $recentFrom
			  AND coalesce(o.vote_count, 0) >= $minVotes
			RETURN o, r2 ORDER BY o.vote_count DESC LIMIT $recentSlots
	}
	RETURN m AS movie, person, rel, kind, collect({film: o, rel: r2}) AS films
	ORDER BY kind, coalesce(rel.order, 0)`

// Pathways returns up to costars cast members of a movie, top billing
// first, each with up to films of their other dated films by vote count
// plus recentSlots more of their newest, narrowed by f — which can narrow
// it to one person — plus the film's directors (who ignore billing). People
// with no qualifying other film are skipped: they cannot lead anywhere
// on the map. Directors are spliced in after the first actor so they
// are always in the candidate pool; the map ranks hops itself.
func (s *Store) Pathways(ctx context.Context, movieID, costars, films int, f PathwayFilter) (*Pathways, error) {
	records, err := s.run(ctx, pathwaysCypher, map[string]any{
		"id": movieID, "costars": costars, "films": films,
		"billing": f.MaxBilling, "minVotes": f.MinVotes, "person": f.PersonID,
		"directors":  maxDirectorPathways,
		"recentFrom": recentFrom(s.now()), "recentSlots": recentSlots,
	})
	if err != nil {
		return nil, fmt.Errorf("graph: pathways of movie %d: %w", movieID, err)
	}
	// No rows means either no hops or no such movie; only then is a second
	// query needed to tell those apart.
	if len(records) == 0 {
		movie, err := s.movie(ctx, movieID)
		if err != nil {
			return nil, err
		}
		return &Pathways{Movie: movie, Cast: []Pathway{}}, nil
	}

	movie, err := recordNode(records[0], "movie")
	if err != nil {
		return nil, err
	}
	var actors, directors []Pathway
	for _, rec := range records {
		pw, err := pathwayFromRecord(rec)
		if err != nil {
			return nil, err
		}
		kind, _ := rec.Get("kind")
		if anyInt(kind) == kindDirector {
			directors = append(directors, pw)
			continue
		}
		actors = append(actors, pw)
	}
	return &Pathways{Movie: movie, Cast: spliceDirectors(actors, directors)}, nil
}

func pathwayFromRecord(rec *neo4j.Record) (Pathway, error) {
	person, err := recordNode(rec, "person")
	if err != nil {
		return Pathway{}, err
	}
	rel, _ := rec.Get("rel")
	r, ok := rel.(dbtype.Relationship)
	if !ok {
		return Pathway{}, fmt.Errorf("graph: rel column is %T, want Relationship", rel)
	}
	raw, _ := rec.Get("films")
	list, _ := raw.([]any)
	pw := Pathway{Person: person, Role: relRole(r), Order: propInt(r.Props, "order"), Films: []PathwayFilm{}}
	for _, item := range list {
		entry, _ := item.(map[string]any)
		n, ok := entry["film"].(dbtype.Node)
		if !ok {
			return Pathway{}, fmt.Errorf("graph: films item film is %T, want Node", entry["film"])
		}
		r2, ok := entry["rel"].(dbtype.Relationship)
		if !ok {
			return Pathway{}, fmt.Errorf("graph: films item rel is %T, want Relationship", entry["rel"])
		}
		film, err := nodeFromDB(n)
		if err != nil {
			return Pathway{}, err
		}
		pw.Films = append(pw.Films, PathwayFilm{Node: film, Role: relRole(r2), Order: propInt(r2.Props, "order")})
	}
	return pw, nil
}

// spliceDirectors keeps the first actor, then inserts directors, then
// the rest of the cast, so a billing-limited actor query still hands
// the map the film's directors as candidates.
func spliceDirectors(actors, directors []Pathway) []Pathway {
	if len(directors) == 0 {
		return actors
	}
	if len(actors) == 0 {
		return directors
	}
	out := make([]Pathway, 0, len(actors)+len(directors))
	out = append(out, actors[0])
	out = append(out, directors...)
	out = append(out, actors[1:]...)
	return out
}
