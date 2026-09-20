package graph

import (
	"context"
	"fmt"
)

// WriteMovieCast upserts a movie, its cast members, its directors, and the
// ACTED_IN / DIRECTED edges between them. Movie properties are refreshed
// because the movie endpoint is the authoritative source for them, and
// crawled_at marks the movie as expanded (see MovieCrawled).
func (s *Store) WriteMovieCast(ctx context.Context, m Movie, cast []CastEntry, directors []Person) error {
	rows := make([]map[string]any, 0, len(cast))
	for _, c := range cast {
		rows = append(rows, map[string]any{
			"personId":   c.Person.ID,
			"name":       c.Person.Name,
			"popularity": c.Person.Popularity,
			"character":  c.Character,
			"order":      c.Order,
		})
	}
	const cypher = `
		MERGE (m:Movie {id: $movie.id})
		SET m.title = $movie.title, m.release_date = $movie.releaseDate, m.year = $movie.year,
		    m.poster_path = $movie.posterPath, m.backdrop_path = $movie.backdropPath,
		    m.rating = $movie.rating, m.vote_count = $movie.voteCount,
		    m.imdb_id = $movie.imdbId, m.crawled_at = datetime(),
		    m.imdb_rating = coalesce($movie.imdbRating, m.imdb_rating),
		    m.imdb_votes = coalesce($movie.imdbVotes, m.imdb_votes)
		WITH m
		UNWIND $cast AS c
		MERGE (p:Person {id: c.personId})
		SET p.name = c.name, p.popularity = c.popularity
		MERGE (p)-[r:ACTED_IN]->(m)
		SET r.character = c.character, r.order = c.order`
	_, err := s.run(ctx, cypher, map[string]any{"movie": movieParams(m), "cast": rows})
	if err != nil {
		return fmt.Errorf("graph: write movie %d cast: %w", m.ID, err)
	}
	if err := s.writeMovieDirectors(ctx, m.ID, directors); err != nil {
		return fmt.Errorf("graph: write movie %d cast: %w", m.ID, err)
	}
	return nil
}

func (s *Store) writeMovieDirectors(ctx context.Context, movieID int, directors []Person) error {
	if len(directors) == 0 {
		return nil
	}
	rows := make([]map[string]any, 0, len(directors))
	for _, d := range directors {
		rows = append(rows, map[string]any{"id": d.ID, "name": d.Name, "popularity": d.Popularity})
	}
	const cypher = `
		MATCH (m:Movie {id: $id})
		UNWIND $directors AS d
		MERGE (p:Person {id: d.id})
		SET p.name = d.name, p.popularity = d.popularity
		MERGE (p)-[r:DIRECTED]->(m)
		SET r.job = 'Director'`
	_, err := s.run(ctx, cypher, map[string]any{"id": movieID, "directors": rows})
	return err
}

// WriteFilmography upserts a person and every movie they acted in or
// directed. Title and date are only filled in ON CREATE (the movie endpoint
// owns them once fetched); rating, votes and poster are the same figures
// from either endpoint, so the latest write wins and a movie never loses
// its poster.
func (s *Store) WriteFilmography(ctx context.Context, p Person, credits []FilmCredit) error {
	acted := make([]map[string]any, 0)
	directed := make([]map[string]any, 0)
	for _, c := range credits {
		row := movieParams(c.Movie)
		if c.Job == JobDirector {
			row["job"] = c.Job
			directed = append(directed, row)
			continue
		}
		row["character"] = c.Character
		row["order"] = c.Order
		acted = append(acted, row)
	}
	person := map[string]any{"id": p.ID, "name": p.Name, "popularity": p.Popularity}
	// The person is upserted here even when they have no acting credits, so a
	// director-only filmography still lands in the graph.
	if err := s.writeCredits(ctx, p.ID, person, acted, actedCreditCypher); err != nil {
		return err
	}
	if len(directed) == 0 {
		return nil
	}
	return s.writeCredits(ctx, p.ID, person, directed, directedCreditCypher)
}

const movieUpsert = `
		MERGE (m:Movie {id: c.id})
		ON CREATE SET m.title = c.title, m.release_date = c.releaseDate, m.year = c.year
		SET m.rating = c.rating, m.vote_count = c.voteCount,
		    m.poster_path = coalesce(nullif(c.posterPath, ''), m.poster_path),
		    m.backdrop_path = coalesce(nullif(c.backdropPath, ''), m.backdrop_path)`

const actedCreditCypher = `
		MERGE (p:Person {id: $person.id})
		SET p.name = $person.name, p.popularity = $person.popularity
		WITH p
		UNWIND $credits AS c` + movieUpsert + `
		MERGE (p)-[r:ACTED_IN]->(m)
		SET r.character = c.character, r.order = c.order`

const directedCreditCypher = `
		MERGE (p:Person {id: $person.id})
		SET p.name = $person.name, p.popularity = $person.popularity
		WITH p
		UNWIND $credits AS c` + movieUpsert + `
		MERGE (p)-[r:DIRECTED]->(m)
		SET r.job = c.job`

func (s *Store) writeCredits(ctx context.Context, personID int, person map[string]any, credits []map[string]any, cypher string) error {
	params := map[string]any{"person": person, "credits": credits}
	if _, err := s.run(ctx, cypher, params); err != nil {
		return fmt.Errorf("graph: write person %d filmography: %w", personID, err)
	}
	return nil
}

// WriteIMDbRating sets a movie's IMDb rating after the fact, so the OMDb
// lookup can run alongside the cast fan-out instead of ahead of it.
func (s *Store) WriteIMDbRating(ctx context.Context, movieID int, rating float64, votes int) error {
	const cypher = `MATCH (m:Movie {id: $id}) SET m.imdb_rating = $rating, m.imdb_votes = $votes`
	if _, err := s.run(ctx, cypher, map[string]any{"id": movieID, "rating": rating, "votes": votes}); err != nil {
		return fmt.Errorf("graph: write movie %d imdb rating: %w", movieID, err)
	}
	return nil
}

func movieParams(m Movie) map[string]any {
	var year, imdbRating, imdbVotes any
	if y := YearOf(m.ReleaseDate); y > 0 {
		year = y
	}
	if m.IMDbRating > 0 {
		imdbRating, imdbVotes = m.IMDbRating, m.IMDbVotes
	}
	return map[string]any{
		"id":           m.ID,
		"title":        m.Title,
		"releaseDate":  m.ReleaseDate,
		"year":         year,
		"posterPath":   m.PosterPath,
		"backdropPath": m.BackdropPath,
		"rating":       m.Rating,
		"voteCount":    m.VoteCount,
		"imdbId":       m.IMDbID,
		"imdbRating":   imdbRating,
		"imdbVotes":    imdbVotes,
	}
}
