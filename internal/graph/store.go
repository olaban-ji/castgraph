// Package graph reads and writes the movie/person network in Neo4j.
package graph

import (
	"context"
	"fmt"

	"github.com/neo4j/neo4j-go-driver/v5/neo4j"
)

// Store wraps a Neo4j driver. It is safe for concurrent use.
type Store struct {
	driver neo4j.DriverWithContext
	db     string
}

// Open connects to Neo4j and verifies the connection.
func Open(ctx context.Context, uri, user, password string) (*Store, error) {
	driver, err := neo4j.NewDriverWithContext(uri, neo4j.BasicAuth(user, password, ""))
	if err != nil {
		return nil, fmt.Errorf("graph: open %s: %w", uri, err)
	}
	if err := driver.VerifyConnectivity(ctx); err != nil {
		driver.Close(ctx)
		return nil, fmt.Errorf("graph: connect %s: %w", uri, err)
	}
	return &Store{driver: driver, db: "neo4j"}, nil
}

// Close releases the driver's connections.
func (s *Store) Close(ctx context.Context) error { return s.driver.Close(ctx) }

// EnsureSchema creates the uniqueness constraints (and their backing
// indexes) that every MERGE below relies on.
func (s *Store) EnsureSchema(ctx context.Context) error {
	stmts := []string{
		`CREATE CONSTRAINT movie_id IF NOT EXISTS FOR (m:Movie) REQUIRE m.id IS UNIQUE`,
		`CREATE CONSTRAINT person_id IF NOT EXISTS FOR (p:Person) REQUIRE p.id IS UNIQUE`,
	}
	for _, stmt := range stmts {
		if _, err := s.run(ctx, stmt, nil); err != nil {
			return fmt.Errorf("graph: ensure schema: %w", err)
		}
	}
	return nil
}

// run executes one auto-committed, retried query and returns its records.
func (s *Store) run(ctx context.Context, cypher string, params map[string]any) ([]*neo4j.Record, error) {
	res, err := neo4j.ExecuteQuery(ctx, s.driver, cypher, params,
		neo4j.EagerResultTransformer, neo4j.ExecuteQueryWithDatabase(s.db))
	if err != nil {
		return nil, err
	}
	return res.Records, nil
}
