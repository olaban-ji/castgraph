package catalog

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// ErrNotFound is returned for an id the catalog cannot build a map from.
var ErrNotFound = errors.New("catalog: not found")

// Person is one chip: someone billed on the searched movie.
type Person struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Role      string `json:"role"` // "cast" or "director"
	Character string `json:"character,omitempty"`
	Order     int    `json:"order"`
}

// Movie is what a card says once its detail has arrived.
type Movie struct {
	ID       string   `json:"id"`
	Title    string   `json:"title"`
	Year     int      `json:"year"`
	Rating   *float64 `json:"rating"`
	MD       int      `json:"md"`
	Poster   string   `json:"poster,omitempty"`
	Released string   `json:"released,omitempty"`
	People   []string `json:"people"`
	IsAnchor bool     `json:"isAnchor"`
}

// Grid is a whole map: the searched movie, its people, and the spine.
type Grid struct {
	Anchor Movie    `json:"anchor"`
	People []Person `json:"people"`
	Films  [][4]any `json:"films"`
}

// gridFilm is the film test, written once and used by every query that
// asks what belongs on a map. A documentary is a movie and an adult
// title is a movie, so both are stored; neither is mapped.
//
// A movie with no release date yet — one the poster job has not reached
// — is placed on its IMDb year. Holding it back would empty most of the
// map until the backfill finished.
const gridFilm = `
	NOT t.is_adult
	AND t.start_year IS NOT NULL
	AND NOT (t.genres @> ARRAY['Documentary'])
	AND (p.released IS NULL OR p.released <= current_date)
	AND t.start_year <= EXTRACT(year FROM current_date)`

// ReadTimeout bounds one read. A map is two indexed joins; anything
// slower than this is a problem to see rather than to wait through.
const ReadTimeout = 5 * time.Second

// Grid builds a whole map for one movie, live from the tables. There is
// no precomputed spine: the two joins below are indexed, and reading
// them means a poster learned an hour ago shows up now rather than
// after the next import.
func (s *Store) Grid(ctx context.Context, tconst string) (*Grid, error) {
	ctx, cancel := context.WithTimeout(ctx, ReadTimeout)
	defer cancel()

	anchor, err := s.movie(ctx, tconst)
	if err != nil {
		return nil, err
	}
	anchor.IsAnchor = true

	people, err := s.peopleOn(ctx, tconst)
	if err != nil {
		return nil, err
	}
	if len(people) == 0 {
		return nil, fmt.Errorf("catalog: %s has nobody billed: %w", tconst, ErrNotFound)
	}
	// The anchor is a card like any other, and its card draws its
	// people; a null there would be "not known yet" rather than "all of
	// them", which is the opposite of the truth for this one.
	anchor.People = make([]string, len(people))
	for i, p := range people {
		anchor.People[i] = p.ID
	}

	films, err := s.spine(ctx, tconst, people)
	if err != nil {
		return nil, err
	}
	return &Grid{Anchor: anchor, People: people, Films: films}, nil
}

// movie reads one row, with its poster and date.
func (s *Store) movie(ctx context.Context, tconst string) (Movie, error) {
	var m Movie
	var released *time.Time
	var poster *string
	err := s.pool.QueryRow(ctx, `
		SELECT t.tconst, t.primary_title, coalesce(t.start_year, 0),
		       r.average_rating, p.poster_url, p.released
		FROM `+Live+`.titles t
		LEFT JOIN `+Live+`.ratings r USING (tconst)
		LEFT JOIN meta.posters p USING (tconst)
		WHERE t.tconst = $1`, tconst).
		Scan(&m.ID, &m.Title, &m.Year, &m.Rating, &poster, &released)
	if errors.Is(err, pgx.ErrNoRows) {
		return Movie{}, fmt.Errorf("catalog: %s: %w", tconst, ErrNotFound)
	}
	if err != nil {
		return Movie{}, fmt.Errorf("catalog: read %s: %w", tconst, err)
	}
	if poster != nil {
		m.Poster = *poster
	}
	if released != nil {
		m.Released = released.Format("2006-01-02")
		m.MD = int(released.Month())*100 + released.Day()
	}
	return m, nil
}

// peopleOn is the chip row: billed cast, then directors. A person who
// both acted and directed is shown as a director, because that is the
// larger claim on the film.
func (s *Store) peopleOn(ctx context.Context, tconst string) ([]Person, error) {
	rows, err := s.pool.Query(ctx, `
		WITH credited AS (
		    SELECT pr.nconst,
		           CASE WHEN bool_or(pr.category = 'director') THEN 'director' ELSE 'cast' END AS role,
		           min(pr.ordering) AS ord,
		           (array_agg(pr.character ORDER BY pr.ordering)
		             FILTER (WHERE pr.character IS NOT NULL))[1] AS character
		    FROM `+Live+`.principals pr
		    WHERE pr.tconst = $1
		    GROUP BY pr.nconst
		    UNION ALL
		    SELECT d.nconst, 'director', -1000 + d.ordering, NULL
		    FROM `+Live+`.directors d
		    WHERE d.tconst = $1
		)
		SELECT c.nconst,
		       coalesce(n.primary_name, ''),
		       CASE WHEN bool_or(c.role = 'director') THEN 'director' ELSE 'cast' END,
		       min(c.ord),
		       (array_agg(c.character) FILTER (WHERE c.character IS NOT NULL))[1]
		FROM credited c
		JOIN `+Live+`.names n USING (nconst)
		GROUP BY c.nconst, n.primary_name
		ORDER BY min(c.ord)`, tconst)
	if err != nil {
		return nil, fmt.Errorf("catalog: people on %s: %w", tconst, err)
	}
	defer rows.Close()

	var out []Person
	for rows.Next() {
		var p Person
		var character *string
		if err := rows.Scan(&p.ID, &p.Name, &p.Role, &p.Order, &character); err != nil {
			return nil, fmt.Errorf("catalog: scan person: %w", err)
		}
		if character != nil {
			p.Character = *character
		}
		p.Order = len(out)
		out = append(out, p)
	}
	return out, rows.Err()
}

// MaxSpine bounds one map. A career is wider than a screen, and a
// thousand cards is a map nobody can read; the most voted survive.
const MaxSpine = 400

// spine is every movie those people made, as the four facts that place a
// card: id, year, rating, month-day. The whole set comes back at once,
// so a card's place is final from the first paint.
func (s *Store) spine(ctx context.Context, anchor string, people []Person) ([][4]any, error) {
	ids := make([]string, len(people))
	for i, p := range people {
		ids[i] = p.ID
	}
	rows, err := s.pool.Query(ctx, `
		WITH theirs AS (
		    SELECT DISTINCT pr.tconst
		    FROM `+Live+`.principals pr
		    WHERE pr.nconst = ANY($1) AND pr.category IN ('actor','actress','director')
		    UNION
		    SELECT DISTINCT d.tconst
		    FROM `+Live+`.directors d
		    WHERE d.nconst = ANY($1)
		)
		SELECT t.tconst, t.start_year, r.average_rating, p.released
		FROM theirs
		JOIN `+Live+`.titles t USING (tconst)
		LEFT JOIN `+Live+`.ratings r USING (tconst)
		LEFT JOIN meta.posters p USING (tconst)
		WHERE `+gridFilm+`
		ORDER BY (t.tconst = $2) DESC, coalesce(r.num_votes, 0) DESC
		LIMIT $3`, ids, anchor, MaxSpine)
	if err != nil {
		return nil, fmt.Errorf("catalog: spine for %s: %w", anchor, err)
	}
	defer rows.Close()

	films := make([][4]any, 0, 256)
	for rows.Next() {
		var id string
		var year int
		var rating *float64
		var released *time.Time
		if err := rows.Scan(&id, &year, &rating, &released); err != nil {
			return nil, fmt.Errorf("catalog: scan spine row: %w", err)
		}
		md := 0
		if released != nil {
			md = int(released.Month())*100 + released.Day()
		}
		// A typed nil inside an `any` is not nil, and this tuple is
		// read as much by Go as by the client. Unrated is a plain nil.
		var score any
		if rating != nil {
			score = *rating
		}
		films = append(films, [4]any{id, year, score, md})
	}
	return films, rows.Err()
}

// Films is what the cards on screen say, asked for by id.
func (s *Store) Films(ctx context.Context, anchor string, ids []string) ([]Movie, error) {
	ctx, cancel := context.WithTimeout(ctx, ReadTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx, `
		SELECT t.tconst, t.primary_title, coalesce(t.start_year, 0),
		       r.average_rating, p.poster_url, p.released,
		       coalesce(
		           (SELECT array_agg(DISTINCT who.nconst)
		            FROM (
		                SELECT pr.nconst FROM `+Live+`.principals pr
		                WHERE pr.tconst = t.tconst AND pr.nconst = ANY($2)
		                UNION
		                SELECT d.nconst FROM `+Live+`.directors d
		                WHERE d.tconst = t.tconst AND d.nconst = ANY($2)
		            ) who),
		           '{}') AS people
		FROM `+Live+`.titles t
		LEFT JOIN `+Live+`.ratings r USING (tconst)
		LEFT JOIN meta.posters p USING (tconst)
		WHERE t.tconst = ANY($1)`, ids, s.anchorPeople(ctx, anchor))
	if err != nil {
		return nil, fmt.Errorf("catalog: films: %w", err)
	}
	defer rows.Close()

	out := make([]Movie, 0, len(ids))
	for rows.Next() {
		var m Movie
		var poster *string
		var released *time.Time
		if err := rows.Scan(&m.ID, &m.Title, &m.Year, &m.Rating, &poster, &released, &m.People); err != nil {
			return nil, fmt.Errorf("catalog: scan film: %w", err)
		}
		if m.People == nil {
			m.People = []string{}
		}
		if poster != nil {
			m.Poster = *poster
		}
		if released != nil {
			m.Released = released.Format("2006-01-02")
			m.MD = int(released.Month())*100 + released.Day()
		}
		m.IsAnchor = m.ID == anchor
		out = append(out, m)
	}
	return out, rows.Err()
}

// anchorPeople is the ids of the searched movie's people, which is what
// a card's markers are drawn from.
func (s *Store) anchorPeople(ctx context.Context, tconst string) []string {
	people, err := s.peopleOn(ctx, tconst)
	if err != nil {
		return nil
	}
	ids := make([]string, len(people))
	for i, p := range people {
		ids[i] = p.ID
	}
	return ids
}
