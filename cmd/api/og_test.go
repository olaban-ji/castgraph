package main

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"cinedikt/internal/catalog"
)

// fakeOGStore is a catalog with one movie in it and a table in memory.
type fakeOGStore struct {
	title  string
	year   int
	poster string
	err    error

	mu   sync.Mutex
	rows map[string][]byte
	puts int
}

func (f *fakeOGStore) MovieMeta(context.Context, string) (string, int, string, error) {
	if f.err != nil {
		return "", 0, "", f.err
	}
	return f.title, f.year, f.poster, nil
}

func (f *fakeOGStore) OGImage(_ context.Context, tconst, v string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.rows[tconst+"-"+v], nil
}

func (f *fakeOGStore) PutOGImage(_ context.Context, tconst, v string, body []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.rows == nil {
		f.rows = map[string][]byte{}
	}
	f.rows[tconst+"-"+v] = body
	f.puts++
	return nil
}

// posterServer stands in for the image host.
func posterServer(t *testing.T, status int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if status != http.StatusOK {
			w.WriteHeader(status)
			return
		}
		// A portrait picture, so the cover crop has something to do.
		art := image.NewRGBA(image.Rect(0, 0, 400, 600))
		for y := 0; y < 600; y++ {
			for x := 0; x < 400; x++ {
				art.Set(x, y, color.RGBA{R: uint8(x % 256), G: 0x40, B: 0x80, A: 0xff})
			}
		}
		w.Header().Set("Content-Type", "image/jpeg")
		_ = jpeg.Encode(w, art, nil)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func ogServerFor(t *testing.T, store ogStore) *httptest.Server {
	t.Helper()
	cards, err := newOGServer(store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(cards)
	t.Cleanup(srv.Close)
	return srv
}

// get fetches without following the redirect, so a fallback can be seen.
func get(t *testing.T, srv *httptest.Server, path string) *http.Response {
	t.Helper()
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	resp, err := client.Get(srv.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func TestShareCardIsTheRightSizeAndCarriesTheRing(t *testing.T) {
	art := posterServer(t, http.StatusOK)
	store := &fakeOGStore{title: "The Matrix", year: 1999, poster: art.URL + "/poster.jpg"}
	srv := ogServerFor(t, store)

	resp := get(t, srv, "/og/movie/tt0133093.png")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Type"); got != "image/png" {
		t.Errorf("Content-Type = %q, want image/png", got)
	}
	if got := resp.Header.Get("Cache-Control"); got != ogCache {
		t.Errorf("Cache-Control = %q, want %q", got, ogCache)
	}
	want := `"tt0133093-` + catalog.OGVersion(store.poster, store.title) + `"`
	if got := resp.Header.Get("ETag"); got != want {
		t.Errorf("ETag = %q, want %q", got, want)
	}

	img := decodePNG(t, resp.Body)
	if b := img.Bounds(); b.Dx() != ogW || b.Dy() != ogH {
		t.Fatalf("card is %dx%d, want %dx%d", b.Dx(), b.Dy(), ogW, ogH)
	}
	// The gold ring runs down the left of the poster, and the panel
	// behind the words is the app's own ground.
	near(t, img, 62, 300, ogGold, 8, "the ring")
	near(t, img, 1100, 20, ogGround, 4, "the ground")
}

func TestShareCardIsDrawnOnceAndThenRead(t *testing.T) {
	art := posterServer(t, http.StatusOK)
	store := &fakeOGStore{title: "The Matrix", year: 1999, poster: art.URL + "/poster.jpg"}
	srv := ogServerFor(t, store)

	first, _ := io.ReadAll(get(t, srv, "/og/movie/tt0133093.png").Body)
	second, _ := io.ReadAll(get(t, srv, "/og/movie/tt0133093.png").Body)
	if !bytes.Equal(first, second) {
		t.Error("the second request drew a different card")
	}
	if store.puts != 1 {
		t.Errorf("stored %d times, want 1", store.puts)
	}
}

func TestShareCardWithoutItsPosterIsNotKept(t *testing.T) {
	art := posterServer(t, http.StatusInternalServerError)
	store := &fakeOGStore{title: "The Matrix", year: 1999, poster: art.URL + "/poster.jpg"}
	srv := ogServerFor(t, store)

	resp := get(t, srv, "/og/movie/tt0133093.png")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if got := resp.Header.Get("Cache-Control"); got != ogRetry {
		t.Errorf("Cache-Control = %q, want %q — the next request has to try again", got, ogRetry)
	}
	if store.puts != 0 {
		t.Error("a card drawn without its poster was stored")
	}
	img := decodePNG(t, resp.Body)
	// Still a whole card, ring and all.
	if b := img.Bounds(); b.Dx() != ogW || b.Dy() != ogH {
		t.Fatalf("card is %dx%d", b.Dx(), b.Dy())
	}
	near(t, img, 62, 300, ogGold, 8, "the ring")
	// And the poster's place is the film's own colour, not the ground.
	if at(img, 200, 300) == ogGround {
		t.Error("the poster's place was left empty")
	}
}

func TestShareCardFallsBackToTheSiteCard(t *testing.T) {
	for _, c := range []struct {
		name, path string
		store      ogStore
	}{
		{"an unknown movie", "/og/movie/tt9999999.png", &fakeOGStore{err: errors.New("not found")}},
		{"a movie with no title", "/og/movie/tt9999999.png", &fakeOGStore{title: "  "}},
		{"not a title id", "/og/movie/603.png", &fakeOGStore{title: "The Matrix"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			resp := get(t, ogServerFor(t, c.store), c.path)
			if resp.StatusCode != http.StatusFound {
				t.Fatalf("status = %d, want 302", resp.StatusCode)
			}
			if got := resp.Header.Get("Location"); got != ogGeneric {
				t.Errorf("Location = %q, want %q", got, ogGeneric)
			}
		})
	}
}

func TestShareCardAnswersHeadAndRefusesPost(t *testing.T) {
	art := posterServer(t, http.StatusOK)
	srv := ogServerFor(t, &fakeOGStore{title: "The Matrix", year: 1999, poster: art.URL + "/p.jpg"})

	resp, err := http.Head(srv.URL + "/og/movie/tt0133093.png")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "image/png" {
		t.Errorf("HEAD = %d %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}

	resp, err = http.Post(srv.URL+"/og/movie/tt0133093.png", "text/plain", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST = %d, want 405", resp.StatusCode)
	}
}

func TestShareCardWrapsALongTitle(t *testing.T) {
	cards, err := newOGServer(&fakeOGStore{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	const long = "Dr. Strangelove or: How I Learned to Stop Worrying and Love the Bomb"
	face, lead, lines := cards.wrapTitle(long)
	if len(lines) <= titleMaxLines {
		t.Fatalf("a title this long fitted in %d lines; the fixture is no longer long", len(lines))
	}
	if lead != titleSmallLead {
		t.Errorf("leading = %d, want the smaller size's %d", lead, titleSmallLead)
	}
	if len(lines) > titleHardMax {
		t.Errorf("%d lines, want at most %d", len(lines), titleHardMax)
	}
	// Four lines is the most a title gets, and Strangelove fits in
	// them, so it is shown whole.
	if strings.HasSuffix(lines[len(lines)-1], "…") {
		t.Errorf("a title that fitted was cut anyway: %q", lines[len(lines)-1])
	}
	if got := strings.Join(lines, " "); got != long {
		t.Errorf("the title came back as %q", got)
	}
	for _, line := range lines {
		if w := textWidth(face.face, line); w > textW {
			t.Errorf("%q is %dpx wide, past the %dpx box", line, w, textW)
		}
	}

	// Past four lines it is cut, and says so.
	_, _, cut := cards.wrapTitle(long + " " + long)
	if len(cut) != titleHardMax {
		t.Fatalf("a title twice that long came out as %d lines", len(cut))
	}
	if !strings.HasSuffix(cut[len(cut)-1], "…") {
		t.Errorf("a cut title did not say so: %q", cut[len(cut)-1])
	}

	// A short title stays at the large size, on one line.
	_, lead, lines = cards.wrapTitle("Heat")
	if lead != titleLead || len(lines) != 1 {
		t.Errorf("Heat came out as %d lines at leading %d", len(lines), lead)
	}
}

func TestShareCardBreaksAWordNothingCouldFit(t *testing.T) {
	cards, err := newOGServer(&fakeOGStore{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	lines := wrapText(cards.title.face, strings.Repeat("M", 60), textW)
	if len(lines) < 2 {
		t.Fatal("a word wider than the card was left to run off the side")
	}
	for _, line := range lines {
		if w := textWidth(cards.title.face, line); w > textW {
			t.Errorf("%q is %dpx wide, past the %dpx box", line, w, textW)
		}
	}
}

func TestShareCardColourMatchesTheClient(t *testing.T) {
	// The same hash the client's hueOf uses, so for a film with no
	// poster the card and the map start from the same hue.
	got := ogColourFor("The Matrix")
	if got.A != 0xff {
		t.Errorf("fallback colour is translucent: %+v", got)
	}
	if ogColourFor("The Matrix") != got {
		t.Error("the colour is not stable for one title")
	}
	if ogColourFor("Heat") == got {
		t.Error("two titles came out the same colour")
	}
}

func TestPosterIsAskedForAtTheWidthItIsDrawn(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{
			"https://m.media-amazon.com/images/M/abc.jpg",
			"https://m.media-amazon.com/images/M/abc._SX780_.jpg",
		},
		{
			"https://m.media-amazon.com/images/M/abc._V1_SX300.jpg",
			"https://m.media-amazon.com/images/M/abc._SX780_.jpg",
		},
		// TMDb names the width in the path instead. The fallback
		// stores these for films OMDb had no picture for.
		{
			"https://image.tmdb.org/t/p/w342/abc.jpg",
			"https://image.tmdb.org/t/p/w780/abc.jpg",
		},
		// An image host this does not know is fetched as it stands.
		{"https://example.com/p.jpg", "https://example.com/p.jpg"},
	} {
		if got := ogPosterURL(c.in); got != c.want {
			t.Errorf("ogPosterURL(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestMovieRouteCarriesThePerMovieCard(t *testing.T) {
	// The page a scraper actually reads, with the image URL on it.
	dir := indexFixture(t)
	api := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	srv := httptest.NewServer(routes(api, dir, theMatrix, nil, slog.New(slog.NewTextHandler(io.Discard, nil))))
	t.Cleanup(srv.Close)

	head := fetchHead(t, srv, "/movie/tt0133093-the-matrix")
	want := "https://cinedikt.com/og/movie/tt0133093.png?v=" +
		catalog.OGVersion(matrixPoster, "The Matrix")
	if !strings.Contains(head, want) {
		t.Errorf("the head does not carry %s", want)
	}
}

// goldenPath is where a reference card is kept.
func goldenPath(name string) string { return filepath.Join("testdata", name+".png") }

// TestShareCardMatchesItsGolden compares against a stored card, within
// a tolerance: font rasterising differs a little between machines, so
// an exact match would fail on somebody else's laptop and tell them
// nothing. Run with -update to redraw the references.
func TestShareCardMatchesItsGolden(t *testing.T) {
	art := posterServer(t, http.StatusOK)
	cards, err := newOGServer(&fakeOGStore{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	poster, ok := cards.fetchPoster(context.Background(), art.URL+"/p.jpg")
	if !ok {
		t.Fatal("the fixture poster did not load")
	}

	for _, c := range []struct {
		name  string
		title string
		year  int
		art   image.Image
	}{
		{"matrix", "The Matrix", 1999, poster},
		{"no-poster", "The Matrix", 1999, nil},
		{"long-title", "Dr. Strangelove or: How I Learned to Stop Worrying and Love the Bomb", 1964, poster},
	} {
		t.Run(c.name, func(t *testing.T) {
			body, err := cards.render(c.title, c.year, c.art)
			if err != nil {
				t.Fatal(err)
			}
			path := goldenPath(c.name)
			if os.Getenv("UPDATE_GOLDEN") != "" {
				if err := os.MkdirAll("testdata", 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, body, 0o644); err != nil {
					t.Fatal(err)
				}
				t.Skip("golden rewritten")
			}
			want, err := os.ReadFile(path)
			if err != nil {
				t.Skipf("no golden yet (%v); run with UPDATE_GOLDEN=1", err)
			}
			compare(t, decodePNG(t, bytes.NewReader(body)), decodePNG(t, bytes.NewReader(want)))
		})
	}
}

// compare fails if two cards differ by more than a rasteriser would.
func compare(t *testing.T, got, want image.Image) {
	t.Helper()
	if got.Bounds() != want.Bounds() {
		t.Fatalf("bounds %v, want %v", got.Bounds(), want.Bounds())
	}
	const tolerance = 2
	off := 0
	for y := want.Bounds().Min.Y; y < want.Bounds().Max.Y; y++ {
		for x := want.Bounds().Min.X; x < want.Bounds().Max.X; x++ {
			a, b := at(got, x, y), at(want, x, y)
			if absDiff(a.R, b.R) > tolerance || absDiff(a.G, b.G) > tolerance ||
				absDiff(a.B, b.B) > tolerance {
				off++
			}
		}
	}
	// A handful of pixels is hinting; a field of them is the layout.
	if limit := want.Bounds().Dx() * want.Bounds().Dy() / 200; off > limit {
		t.Errorf("%d pixels differ by more than %d, past the %d allowed", off, tolerance, limit)
	}
}

func decodePNG(t *testing.T, r io.Reader) image.Image {
	t.Helper()
	img, err := png.Decode(r)
	if err != nil {
		t.Fatal(err)
	}
	return img
}

func at(img image.Image, x, y int) color.NRGBA {
	r, g, b, a := img.At(x, y).RGBA()
	return color.NRGBA{uint8(r >> 8), uint8(g >> 8), uint8(b >> 8), uint8(a >> 8)}
}

func near(t *testing.T, img image.Image, x, y int, want color.NRGBA, tolerance uint8, what string) {
	t.Helper()
	got := at(img, x, y)
	if absDiff(got.R, want.R) > tolerance || absDiff(got.G, want.G) > tolerance ||
		absDiff(got.B, want.B) > tolerance {
		t.Errorf("%s at (%d,%d) is %+v, want about %+v", what, x, y, got, want)
	}
}

func absDiff(a, b uint8) uint8 {
	if a > b {
		return a - b
	}
	return b - a
}
