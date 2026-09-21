package graph

import (
	"context"
	"errors"
	"fmt"

	"github.com/neo4j/neo4j-go-driver/v5/neo4j"
	"github.com/neo4j/neo4j-go-driver/v5/neo4j/dbtype"
)

// ErrNotFound is returned when the requested node is not in the graph.
var ErrNotFound = errors.New("graph: not found")

// MaxNetworkDepth bounds the variable-length expansion in Network.
const MaxNetworkDepth = 3

// Network returns the movies reachable from movieID through shared cast or
// director, depth movie-hops out, capped at limit edges. Edges nearest the
// seed and highest billed come first so a truncated result is still the
// useful part.
func (s *Store) Network(ctx context.Context, movieID, depth, limit int) (*Graph, error) {
	if depth < 1 || depth > MaxNetworkDepth {
		return nil, fmt.Errorf("graph: depth %d out of range 1..%d", depth, MaxNetworkDepth)
	}
	seed, err := s.movie(ctx, movieID)
	if err != nil {
		return nil, err
	}
	// Relationship count is inlined because Cypher does not accept a
	// parameter as a variable-length bound; depth is validated above.
	cypher := fmt.Sprintf(`
		MATCH p = (m:Movie {id: $id})-[:ACTED_IN|DIRECTED*1..%d]-()
		UNWIND relationships(p) AS r
		WITH r, min(length(p)) AS dist
		ORDER BY dist, r.order
		LIMIT $limit
		RETURN startNode(r) AS person, endNode(r) AS movie, r AS rel`, 2*depth)
	records, err := s.run(ctx, cypher, map[string]any{"id": movieID, "limit": limit})
	if err != nil {
		return nil, fmt.Errorf("graph: network of movie %d: %w", movieID, err)
	}
	g := newGraphBuilder()
	g.addNode(seed)
	return g.addEdgeRecords(records)
}

// MovieCrawled reports whether a movie's own cast and directors have been
// fetched. A movie known only as an entry in someone's filmography has
// not been. Movies crawled before directors were stored look crawled but
// return false so the next request backfills them.
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

// Neighbors returns a node's direct ACTED_IN or DIRECTED neighbours: the
// cast and director of a movie, or the filmography of a person.
func (s *Store) Neighbors(ctx context.Context, nodeID string, limit int) (*Graph, error) {
	kind, id, err := ParseNodeID(nodeID)
	if err != nil {
		return nil, err
	}
	var cypher string
	switch kind {
	case KindMovie:
		cypher = `
			MATCH (person:Person)-[rel:ACTED_IN|DIRECTED]->(movie:Movie {id: $id})
			RETURN person, movie, rel ORDER BY rel.order LIMIT $limit`
	case KindPerson:
		cypher = `
			MATCH (person:Person {id: $id})-[rel:ACTED_IN|DIRECTED]->(movie:Movie)
			RETURN person, movie, rel ORDER BY movie.year LIMIT $limit`
	}
	self, err := s.node(ctx, kind, id)
	if err != nil {
		return nil, err
	}
	records, err := s.run(ctx, cypher, map[string]any{"id": id, "limit": limit})
	if err != nil {
		return nil, fmt.Errorf("graph: neighbors of %s: %w", nodeID, err)
	}
	g := newGraphBuilder()
	g.addNode(self)
	return g.addEdgeRecords(records)
}

// MaxPathLength bounds the shortest-path search so a query between two
// unconnected movies terminates.
const MaxPathLength = 12

// ShortestPath returns the shortest chain of shared cast or director
// between two movies, or ErrNotFound when none exists within MaxPathLength hops.
func (s *Store) ShortestPath(ctx context.Context, fromID, toID int) (*Graph, error) {
	for _, id := range []int{fromID, toID} {
		if _, err := s.movie(ctx, id); err != nil {
			return nil, err
		}
	}
	cypher := fmt.Sprintf(`
		MATCH (a:Movie {id: $from}), (b:Movie {id: $to})
		MATCH p = shortestPath((a)-[:ACTED_IN|DIRECTED*..%d]-(b))
		UNWIND relationships(p) AS r
		RETURN startNode(r) AS person, endNode(r) AS movie, r AS rel`, MaxPathLength)
	records, err := s.run(ctx, cypher, map[string]any{"from": fromID, "to": toID})
	if err != nil {
		return nil, fmt.Errorf("graph: path %d->%d: %w", fromID, toID, err)
	}
	if len(records) == 0 {
		return nil, fmt.Errorf("graph: path %d->%d: %w", fromID, toID, ErrNotFound)
	}
	return newGraphBuilder().addEdgeRecords(records)
}

func (s *Store) movie(ctx context.Context, id int) (Node, error) {
	return s.node(ctx, KindMovie, id)
}

func (s *Store) node(ctx context.Context, kind string, id int) (Node, error) {
	label := "Movie"
	if kind == KindPerson {
		label = "Person"
	}
	records, err := s.run(ctx, fmt.Sprintf(`MATCH (n:%s {id: $id}) RETURN n`, label), map[string]any{"id": id})
	if err != nil {
		return Node{}, fmt.Errorf("graph: load %s %d: %w", kind, id, err)
	}
	if len(records) == 0 {
		return Node{}, fmt.Errorf("graph: %s %d: %w", kind, id, ErrNotFound)
	}
	n, err := recordNode(records[0], "n")
	if err != nil {
		return Node{}, err
	}
	return n, nil
}

// graphBuilder accumulates nodes and edges without duplicates.
type graphBuilder struct {
	g    Graph
	seen map[string]bool
}

func newGraphBuilder() *graphBuilder {
	return &graphBuilder{g: Graph{Nodes: []Node{}, Edges: []Edge{}}, seen: map[string]bool{}}
}

func (b *graphBuilder) addNode(n Node) {
	if b.seen[n.ID] {
		return
	}
	b.seen[n.ID] = true
	b.g.Nodes = append(b.g.Nodes, n)
}

// addEdgeRecords consumes records with person, movie and rel columns.
func (b *graphBuilder) addEdgeRecords(records []*neo4j.Record) (*Graph, error) {
	for _, rec := range records {
		person, err := recordNode(rec, "person")
		if err != nil {
			return nil, err
		}
		movie, err := recordNode(rec, "movie")
		if err != nil {
			return nil, err
		}
		rel, ok := rec.Get("rel")
		if !ok {
			return nil, errors.New("graph: record has no rel column")
		}
		r, ok := rel.(dbtype.Relationship)
		if !ok {
			return nil, fmt.Errorf("graph: rel column is %T, want Relationship", rel)
		}
		b.addNode(person)
		b.addNode(movie)
		b.g.Edges = append(b.g.Edges, Edge{
			Source: person.ID,
			Target: movie.ID,
			Role:   relRole(r),
			Order:  propInt(r.Props, "order"),
		})
	}
	return &b.g, nil
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

func propInt(props map[string]any, key string) int {
	switch v := props[key].(type) {
	case int64:
		return int(v)
	case int:
		return v
	case float64:
		return int(v)
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
}

// maxDirectorPathways caps how many directors of one film become hops.
// Features have one; a handful of films have two or three.
const maxDirectorPathways = 4

// Pathways returns up to costars cast members of a movie, top billing
// first, each with up to films of their other dated films by vote count,
// narrowed by f, plus the film's directors (who ignore billing). People
// with no qualifying other film are skipped: they cannot lead anywhere
// on the map. Directors are spliced in after the first actor so they
// are always in the candidate pool; the map ranks hops itself.
func (s *Store) Pathways(ctx context.Context, movieID, costars, films int, f PathwayFilter) (*Pathways, error) {
	movie, err := s.movie(ctx, movieID)
	if err != nil {
		return nil, err
	}
	params := map[string]any{
		"id": movieID, "costars": costars, "films": films,
		"billing": f.MaxBilling, "minVotes": f.MinVotes,
		"directors": maxDirectorPathways,
	}
	actors, err := s.queryPathways(ctx, movieID, actorPathwaysCypher, params)
	if err != nil {
		return nil, err
	}
	directors, err := s.queryPathways(ctx, movieID, directorPathwaysCypher, params)
	if err != nil {
		return nil, err
	}
	return &Pathways{Movie: movie, Cast: spliceDirectors(actors, directors)}, nil
}

const actorPathwaysCypher = `
		MATCH (p:Person)-[r:ACTED_IN]->(m:Movie {id: $id})
		WHERE ($billing = 0 OR r.order <= $billing)
		  AND EXISTS {
			(p)-[r2:ACTED_IN]->(o:Movie)
			WHERE o <> m AND o.year IS NOT NULL
			  AND ($billing = 0 OR r2.order <= $billing)
			  AND coalesce(o.vote_count, 0) >= $minVotes
		  }
		WITH m, p, r ORDER BY r.order LIMIT $costars
		CALL (p, m) {
			MATCH (p)-[r2:ACTED_IN]->(o:Movie)
			WHERE o <> m AND o.year IS NOT NULL
			  AND ($billing = 0 OR r2.order <= $billing)
			  AND coalesce(o.vote_count, 0) >= $minVotes
			RETURN o, r2 ORDER BY o.vote_count DESC LIMIT $films
		}
		RETURN p AS person, r AS rel, collect({film: o, rel: r2}) AS films
		ORDER BY rel.order`

const directorPathwaysCypher = `
		MATCH (p:Person)-[r:DIRECTED]->(m:Movie {id: $id})
		WHERE EXISTS {
			(p)-[:DIRECTED]->(o:Movie)
			WHERE o <> m AND o.year IS NOT NULL
			  AND coalesce(o.vote_count, 0) >= $minVotes
		  }
		WITH m, p, r LIMIT $directors
		CALL (p, m) {
			MATCH (p)-[r2:DIRECTED]->(o:Movie)
			WHERE o <> m AND o.year IS NOT NULL
			  AND coalesce(o.vote_count, 0) >= $minVotes
			RETURN o, r2 ORDER BY o.vote_count DESC LIMIT $films
		}
		RETURN p AS person, r AS rel, collect({film: o, rel: r2}) AS films`

func (s *Store) queryPathways(ctx context.Context, movieID int, cypher string, params map[string]any) ([]Pathway, error) {
	records, err := s.run(ctx, cypher, params)
	if err != nil {
		return nil, fmt.Errorf("graph: pathways of movie %d: %w", movieID, err)
	}
	out := make([]Pathway, 0, len(records))
	for _, rec := range records {
		pw, err := pathwayFromRecord(rec)
		if err != nil {
			return nil, err
		}
		out = append(out, pw)
	}
	return out, nil
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
