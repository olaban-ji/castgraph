package catalog

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func at(day, hour, min int) time.Time {
	return time.Date(2026, 9, day, hour, min, 0, 0, time.UTC)
}

func genAt(when time.Time) Generation {
	g := make(Generation, len(Files))
	for _, f := range Files {
		g[f] = Stamp{LastModified: when}
	}
	return g
}

func TestReadyWaitsForTheWholeSet(t *testing.T) {
	published := genAt(at(23, 0, 42))

	// The real files land within a minute or so of each other, so a
	// partial set is what an hourly check sees mid-publish, not a fault.
	half := genAt(at(23, 0, 42))
	half[TitleBasics] = Stamp{LastModified: at(24, 0, 42)}
	half[TitleRatings] = Stamp{LastModified: at(24, 0, 43)}

	ok, why := Ready(published, half, Files)
	if ok {
		t.Fatal("loaded a principals file on top of yesterday's titles")
	}
	for _, want := range []string{"title.crew", "name.basics", "title.principals"} {
		if !strings.Contains(why, want) {
			t.Errorf("reason does not name the file being waited on (%s): %s", want, why)
		}
	}

	// An hour later the rest have landed.
	whole := genAt(at(24, 0, 43))
	if ok, why := Ready(published, whole, Files); !ok {
		t.Errorf("a complete set was refused: %s", why)
	}
}

func TestReadyRefusesAnUnchangedSet(t *testing.T) {
	published := genAt(at(24, 0, 42))
	if ok, _ := Ready(published, genAt(at(24, 0, 42)), Files); ok {
		t.Error("the same generation started a second import")
	}
	// A file that went backwards is not newer either.
	older := genAt(at(24, 0, 42))
	older[TitleCrew] = Stamp{LastModified: at(23, 0, 42)}
	if ok, _ := Ready(published, older, Files); ok {
		t.Error("a file that moved backwards started an import")
	}
}

func TestReadyIgnoresETagAndLength(t *testing.T) {
	// A rebuilt body under an unchanged Last-Modified is worth logging
	// and is not worth a load: there is nothing to compare the new
	// tables against, and half the set may not have been rebuilt at all.
	published := genAt(at(24, 0, 42))
	next := genAt(at(24, 0, 42))
	for f := range next {
		next[f] = Stamp{LastModified: at(24, 0, 42), ETag: `"different"`, Length: 999}
	}
	if ok, _ := Ready(published, next, Files); ok {
		t.Error("a changed ETag started an import on its own")
	}
}

func TestFirstRunNeedsOnlyFiveStamps(t *testing.T) {
	if ok, why := Ready(nil, genAt(at(24, 0, 42)), Files); !ok {
		t.Errorf("the first run was refused: %s", why)
	}
	// But still all five of them.
	short := genAt(at(24, 0, 42))
	delete(short, TitleRatings)
	if ok, _ := Ready(nil, short, Files); ok {
		t.Error("the first run started without every file")
	}
}

func TestSameCatchesASetThatMovedMidDownload(t *testing.T) {
	opened := genAt(at(24, 0, 42))
	after := genAt(at(24, 0, 42))
	if ok, _ := Same(opened, after, Files); !ok {
		t.Error("an unchanged set was called different")
	}
	after[TitlePrincipals] = Stamp{LastModified: at(24, 0, 55)}
	ok, which := Same(opened, after, Files)
	if ok {
		t.Fatal("the set moved while it was being fetched and nothing noticed")
	}
	if which != TitlePrincipals {
		t.Errorf("blamed %s", which)
	}
}

func TestHeadReadsTheStamp(t *testing.T) {
	var agent string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		agent = r.Header.Get("User-Agent")
		w.Header().Set("Last-Modified", "Thu, 24 Sep 2026 00:42:20 GMT")
		w.Header().Set("ETag", `"abc"`)
		w.Header().Set("Content-Length", "227540992")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	stamp, err := headAt(context.Background(), srv.Client(), srv.URL, TitleBasics)
	if err != nil {
		t.Fatal(err)
	}
	if want := at(24, 0, 42).Add(20 * time.Second); !stamp.LastModified.Equal(want) {
		t.Errorf("Last-Modified = %v, want %v", stamp.LastModified, want)
	}
	if stamp.ETag != `"abc"` || stamp.Length != 227540992 {
		t.Errorf("stamp = %+v", stamp)
	}
	if !strings.Contains(agent, "cinedikt") {
		t.Errorf("User-Agent = %q, want this client named", agent)
	}
}

func TestHeadRefusesAFileWithNoStamp(t *testing.T) {
	// No Last-Modified means nothing to compare, so the hour is skipped
	// rather than guessed at from ETag or length.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("ETag", `"abc"`)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	if _, err := headAt(context.Background(), srv.Client(), srv.URL, TitleBasics); err == nil {
		t.Error("a file with no Last-Modified was accepted")
	}

	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer down.Close()
	if _, err := headAt(context.Background(), down.Client(), down.URL, TitleBasics); err == nil {
		t.Error("a 503 was read as a stamp")
	}
}
