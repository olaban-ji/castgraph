package catalog

import (
	"bytes"
	"compress/gzip"
	"strings"
	"testing"
)

// gzipped writes rows as a gzipped TSV, the way the datasets arrive.
func gzipped(t *testing.T, rows ...string) *bytes.Reader {
	t.Helper()
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	if _, err := w.Write([]byte(strings.Join(rows, "\n") + "\n")); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return bytes.NewReader(buf.Bytes())
}

func TestReaderReadsByColumnName(t *testing.T) {
	r, err := NewReader(gzipped(t,
		"tconst\ttitleType\tprimaryTitle\tisAdult\tstartYear\tgenres",
		"tt0133093\tmovie\tThe Matrix\t0\t1999\tAction,Sci-Fi",
	))
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if !r.Next() {
		t.Fatal("no row")
	}
	if got := r.Text("primaryTitle"); got != "The Matrix" {
		t.Errorf("primaryTitle = %q", got)
	}
	if year, ok := r.Int("startYear"); !ok || year != 1999 {
		t.Errorf("startYear = %d, %v", year, ok)
	}
	if r.Bool("isAdult") {
		t.Error("isAdult should be false for 0")
	}
	if got := r.List("genres"); len(got) != 2 || got[0] != "Action" || got[1] != "Sci-Fi" {
		t.Errorf("genres = %v", got)
	}
	if r.Next() {
		t.Error("there was only one row")
	}
	if err := r.Err(); err != nil {
		t.Errorf("Err() = %v", err)
	}
}

func TestReaderIsNotFooledByColumnOrder(t *testing.T) {
	// The same row with the columns swapped has to read the same way.
	// Reading by position would quietly put the type in the title.
	r, err := NewReader(gzipped(t,
		"titleType\ttconst\tstartYear\tprimaryTitle",
		"movie\ttt0133093\t1999\tThe Matrix",
	))
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	r.Next()
	if got := r.Text("primaryTitle"); got != "The Matrix" {
		t.Errorf("primaryTitle = %q", got)
	}
	if got := r.Text("titleType"); got != "movie" {
		t.Errorf("titleType = %q", got)
	}
}

func TestRequireNamesEveryMissingColumn(t *testing.T) {
	r, err := NewReader(gzipped(t, "tconst\tprimaryTitle", "tt1\tA Film"))
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if err := r.Require("tconst", "primaryTitle"); err != nil {
		t.Errorf("columns that are present: %v", err)
	}
	err = r.Require("tconst", "titleType", "startYear")
	if err == nil {
		t.Fatal("a file missing two columns loaded anyway")
	}
	// Both are named: fixing one and rerunning an hour later to find the
	// other is a whole day of catalog.
	for _, want := range []string{"titleType", "startYear"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error does not name %s: %v", want, err)
		}
	}
}

func TestNullsAndOddValuesBecomeEmpty(t *testing.T) {
	r, err := NewReader(gzipped(t,
		"tconst\tstartYear\tgenres\tcharacters\truntimeMinutes",
		"tt1\t\\N\t\\N\t\\N\tnot-a-number",
	))
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	r.Next()
	if got := r.Text("startYear"); got != "" {
		t.Errorf(`\N should read as empty, got %q`, got)
	}
	if _, ok := r.Int("startYear"); ok {
		t.Error("a null year should not be a number")
	}
	// IMDb does write the occasional non-numeric year. It becomes null
	// rather than failing the row and costing a whole generation.
	if _, ok := r.Int("runtimeMinutes"); ok {
		t.Error("a non-numeric runtime should not parse")
	}
	if got := r.List("genres"); got != nil {
		t.Errorf("a null list should be empty, got %v", got)
	}
}

func TestShortRowDoesNotPanic(t *testing.T) {
	// A truncated line has fewer fields than the header promises.
	r, err := NewReader(gzipped(t, "tconst\ttitleType\tprimaryTitle", "tt1\tmovie"))
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	r.Next()
	if got := r.Text("primaryTitle"); got != "" {
		t.Errorf("missing field = %q, want empty", got)
	}
}

func TestEmptyFileIsAnError(t *testing.T) {
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	w.Close()
	if _, err := NewReader(bytes.NewReader(buf.Bytes())); err == nil {
		t.Error("an empty file was accepted")
	}
}

func TestTruncatedGzipIsAnError(t *testing.T) {
	full := gzipped(t, "tconst\ttitleType", "tt1\tmovie", "tt2\tmovie")
	whole := make([]byte, full.Len())
	full.Read(whole)
	// Cut the stream mid-body: a download that stopped early must fail
	// the read rather than publish a short table.
	r, err := NewReader(bytes.NewReader(whole[:len(whole)-6]))
	if err != nil {
		return // failing at the header is just as good
	}
	defer r.Close()
	for r.Next() {
	}
	if r.Err() == nil {
		t.Error("a truncated gzip read cleanly to the end")
	}
}
