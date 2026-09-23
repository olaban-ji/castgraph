package api

import (
	"context"
	"errors"
	"testing"

	"cinedikt/internal/graph"
)

type fakeFirstRun struct {
	calls int
	err   error
	bands [][]graph.Node
}

func (f *fakeFirstRun) FirstRunCandidates(_ context.Context, bands []graph.FirstRunBand, perBand int) ([][]graph.Node, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	if f.bands != nil {
		return f.bands, nil
	}
	out := make([][]graph.Node, 0, len(bands))
	for i := range bands {
		band := make([]graph.Node, 0, perBand)
		for j := range perBand {
			id := i*1000 + j
			band = append(band, graph.Node{ID: graph.MovieNodeID(id), TMDBID: id, Label: "F", Year: bands[i].From})
		}
		out = append(out, band)
	}
	return out, nil
}

func TestFirstRunOffersOneFilmPerEra(t *testing.T) {
	c := newFirstRunCache(&fakeFirstRun{})
	films := c.films(context.Background())
	if len(films) != len(graph.DefaultFirstRunBands) {
		t.Fatalf("films = %d, want %d", len(films), len(graph.DefaultFirstRunBands))
	}
	years := map[int]bool{}
	for _, f := range films {
		years[f.Year] = true
	}
	if len(years) != len(graph.DefaultFirstRunBands) {
		t.Errorf("eras represented = %d, want one film from each", len(years))
	}
}

func TestFirstRunAnswersDifferentlyEachTime(t *testing.T) {
	c := newFirstRunCache(&fakeFirstRun{})
	ctx := context.Background()
	seen := map[string]bool{}
	for range 30 {
		key := ""
		for _, f := range c.films(ctx) {
			key += f.ID + ","
		}
		seen[key] = true
	}
	// 250 candidates an era: thirty identical draws would mean it is not
	// drawing at all.
	if len(seen) < 25 {
		t.Errorf("distinct sets over 30 draws = %d, want nearly all different", len(seen))
	}
}

func TestFirstRunScansOnceAndThenServesFromMemory(t *testing.T) {
	f := &fakeFirstRun{}
	c := newFirstRunCache(f)
	for range 20 {
		c.films(context.Background())
	}
	if f.calls != 1 {
		t.Errorf("graph reads = %d, want 1", f.calls)
	}
}

func TestFirstRunKeepsServingWhenTheGraphFails(t *testing.T) {
	f := &fakeFirstRun{}
	c := newFirstRunCache(f)
	if got := c.films(context.Background()); len(got) == 0 {
		t.Fatal("first call returned nothing")
	}
	// Force a refresh that fails: the held candidates still answer.
	c.mu.Lock()
	c.fetched = c.fetched.Add(-2 * firstRunTTL)
	c.mu.Unlock()
	f.err = errors.New("neo4j down")
	if got := c.films(context.Background()); len(got) != len(graph.DefaultFirstRunBands) {
		t.Errorf("films after a failed refresh = %d, want the stale set", len(got))
	}
}

func TestFirstRunReturnsNothingWhenItNeverHadAny(t *testing.T) {
	c := newFirstRunCache(&fakeFirstRun{err: errors.New("neo4j down")})
	if got := c.films(context.Background()); got != nil {
		t.Errorf("films = %v, want nil so the client uses its own set", got)
	}
}

func TestFirstRunSkipsEmptyEras(t *testing.T) {
	one := graph.Node{ID: "m:1", TMDBID: 1, Label: "Only", Year: 1999}
	c := newFirstRunCache(&fakeFirstRun{bands: [][]graph.Node{{}, {one}, {}}})
	got := c.films(context.Background())
	if len(got) != 1 || got[0].ID != "m:1" {
		t.Errorf("films = %v, want just the era that had one", got)
	}
}
