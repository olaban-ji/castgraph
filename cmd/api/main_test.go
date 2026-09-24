package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestWebCacheHeaders(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>app</html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "assets", "app-abc123.js"), []byte("console.log(1)"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "favicon.svg"), []byte("<svg/>"), 0o644); err != nil {
		t.Fatal(err)
	}

	api := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	srv := httptest.NewServer(routes(api, dir, nil, slog.New(slog.NewTextHandler(io.Discard, nil))))
	t.Cleanup(srv.Close)

	for _, tc := range []struct {
		path, cache, body string
	}{
		{"/assets/app-abc123.js", assetCacheControl, "console.log(1)"},
		{"/", htmlCacheControl, "<html>app</html>"},
		{"/some/spa/route", htmlCacheControl, "<html>app</html>"},
		{"/favicon.svg", htmlCacheControl, "<svg/>"},
		{"/assets/missing.js", htmlCacheControl, "<html>app</html>"},
	} {
		resp, err := http.Get(srv.URL + tc.path)
		if err != nil {
			t.Fatalf("GET %s: %v", tc.path, err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if got := resp.Header.Get("Cache-Control"); got != tc.cache {
			t.Errorf("GET %s Cache-Control = %q, want %q", tc.path, got, tc.cache)
		}
		if string(body) != tc.body {
			t.Errorf("GET %s body = %q, want %q", tc.path, body, tc.body)
		}
	}
}

func TestShareImageIsAbsolute(t *testing.T) {
	dir := t.TempDir()
	html := `<meta property="og:image" content="/og.png?v=2" />` + "\n" +
		`<meta name="twitter:image" content="/og.png?v=2" />`
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte(html), 0o644); err != nil {
		t.Fatal(err)
	}
	api := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	srv := httptest.NewServer(routes(api, dir, nil, slog.New(slog.NewTextHandler(io.Discard, nil))))
	t.Cleanup(srv.Close)

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/movie/603-the-matrix", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("X-Forwarded-Host", "dev.cinedikt.com")
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	want := `<meta property="og:image" content="https://dev.cinedikt.com/og.png?v=2" />` + "\n" +
		`<meta name="twitter:image" content="https://dev.cinedikt.com/og.png?v=2" />`
	if string(body) != want {
		t.Fatalf("share image tags = %q, want %q", body, want)
	}

	req, err = http.NewRequest(http.MethodGet, srv.URL+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("X-Forwarded-Host", `dev.cinedikt.com"><script>`)
	resp, err = srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != html {
		t.Fatalf("unsafe host was written into the page: %q", body)
	}
}

func TestOldFilmLinksMoveToMovie(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html></html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	api := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	srv := httptest.NewServer(routes(api, dir, nil, slog.New(slog.NewTextHandler(io.Discard, nil))))
	t.Cleanup(srv.Close)

	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	for _, c := range []struct{ from, to string }{
		{"/film/603-the-matrix", "/movie/603-the-matrix"},
		{"/film/603", "/movie/603"},
		{"/film/603-the-matrix?device=phone", "/movie/603-the-matrix?device=phone"},
	} {
		resp, err := client.Get(srv.URL + c.from)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusMovedPermanently {
			t.Errorf("GET %s = %d, want %d", c.from, resp.StatusCode, http.StatusMovedPermanently)
		}
		if got := resp.Header.Get("Location"); got != c.to {
			t.Errorf("GET %s went to %q, want %q", c.from, got, c.to)
		}
	}

	// A map's own address, and anything that is not one, are served.
	for _, path := range []string{"/movie/603-the-matrix", "/film/", "/"} {
		resp, err := client.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("GET %s = %d, want %d", path, resp.StatusCode, http.StatusOK)
		}
	}
}

// indexFixture is the real index.html. The rewrites match tags in the
// page as it actually ships, so a head that is reshaped without them in
// mind fails here rather than in someone's chat window.
func indexFixture(t *testing.T) string {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("..", "..", "web", "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), body, 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func previewServer(t *testing.T, meta movieMeta) *httptest.Server {
	t.Helper()
	api := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	srv := httptest.NewServer(routes(api, indexFixture(t), meta, slog.New(slog.NewTextHandler(io.Discard, nil))))
	t.Cleanup(srv.Close)
	return srv
}

func fetchHead(t *testing.T, srv *httptest.Server, path string) string {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, srv.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("X-Forwarded-Host", "cinedikt.com")
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s = %d, want 200", path, resp.StatusCode)
	}
	return string(body)
}

func theMatrix(_ context.Context, id int) (string, int, error) {
	if id != 603 {
		return "", 0, errors.New("not found")
	}
	return "The Matrix", 1999, nil
}

func TestPreviewNamesTheMovie(t *testing.T) {
	srv := previewServer(t, theMatrix)
	head := fetchHead(t, srv, "/movie/603-the-matrix")

	for _, want := range []string{
		`<title>The Matrix — everything its cast and directors made · Cinedikt</title>`,
		`content="The Matrix (1999) — everything its cast and directors made"`,
		`content="See every movie The Matrix’s cast and directors made, arranged by year and rating."`,
		`<meta property="og:url" content="https://cinedikt.com/movie/603-the-matrix" />`,
		`<meta property="og:image:alt" content="The Matrix — everything its cast and directors made" />`,
		// The card itself is the generic one, absolute and still versioned.
		`<meta property="og:image" content="https://cinedikt.com/og.png?v=3" />`,
		`<meta name="twitter:image" content="https://cinedikt.com/og.png?v=3" />`,
		`<meta property="og:site_name" content="Cinedikt" />`,
	} {
		if !strings.Contains(head, want) {
			t.Errorf("preview is missing %s", want)
		}
	}
	// Both the og: and the plain description say the movie's name.
	if n := strings.Count(head, "See every movie The Matrix’s cast and directors made"); n != 2 {
		t.Errorf("description written %d times, want 2 (og:description and description)", n)
	}
	if strings.Contains(head, "a movie’s cast and directors, and everything they made") {
		t.Error("the tagline is still on a page that knows the movie")
	}
}

func TestPreviewUsesTheCanonicalSlug(t *testing.T) {
	srv := previewServer(t, theMatrix)
	head := fetchHead(t, srv, "/movie/603-wrong-slug")
	if !strings.Contains(head, `content="https://cinedikt.com/movie/603-the-matrix"`) {
		t.Error("og:url followed the pasted slug instead of the stored title")
	}
	// A bare id is a movie route too.
	head = fetchHead(t, srv, "/movie/603")
	if !strings.Contains(head, `content="https://cinedikt.com/movie/603-the-matrix"`) {
		t.Error("og:url is wrong for a link with no slug")
	}
}

func TestPreviewEscapesTheTitle(t *testing.T) {
	srv := previewServer(t, func(_ context.Context, _ int) (string, int, error) {
		return `The "<Movie>" & Co`, 2001, nil
	})
	head := fetchHead(t, srv, "/movie/7")
	if strings.Contains(head, `<Movie>`) || strings.Contains(head, `content="The "`) {
		t.Errorf("an unescaped title reached the page:\n%s", head)
	}
	if !strings.Contains(head, `The &#34;&lt;Movie&gt;&#34; &amp; Co`) {
		t.Errorf("title was not escaped as expected:\n%s", head)
	}
	// And the slug drops the punctuation rather than carrying it into a URL.
	if !strings.Contains(head, `content="https://cinedikt.com/movie/7-the-movie-co"`) {
		t.Error("og:url slug kept characters a URL should not")
	}
}

func TestPreviewFallsBackToTheGenericPage(t *testing.T) {
	tagline := `<title>Cinedikt — a movie’s cast and directors, and everything they made</title>`
	slow := make(chan struct{})
	t.Cleanup(func() { close(slow) })

	for _, c := range []struct {
		name string
		meta movieMeta
	}{
		{"not in the graph", func(context.Context, int) (string, int, error) {
			return "", 0, errors.New("graph: not found")
		}},
		{"the graph is down", func(context.Context, int) (string, int, error) {
			return "", 0, errors.New("dial tcp: connection refused")
		}},
		{"a movie with no title", func(context.Context, int) (string, int, error) {
			return "   ", 0, nil
		}},
		{"slower than the deadline", func(ctx context.Context, _ int) (string, int, error) {
			// Ignores the context on purpose: the page must not wait on a
			// read that will not stop when it is told to.
			select {
			case <-slow:
			case <-time.After(5 * time.Second):
			}
			return "Too Late", 1999, nil
		}},
		{"no lookup at all", nil},
	} {
		t.Run(c.name, func(t *testing.T) {
			srv := previewServer(t, c.meta)
			head := fetchHead(t, srv, "/movie/603-the-matrix")
			if !strings.Contains(head, tagline) {
				t.Errorf("the generic title is gone:\n%s", head)
			}
			if strings.Contains(head, "everything its cast and directors made") {
				t.Error("a movie was named on a page that could not look one up")
			}
		})
	}
}

func TestPreviewOnlyLooksUpMovieRoutes(t *testing.T) {
	var asked []string
	var mu sync.Mutex
	srv := previewServer(t, func(_ context.Context, id int) (string, int, error) {
		mu.Lock()
		asked = append(asked, strconv.Itoa(id))
		mu.Unlock()
		return "The Matrix", 1999, nil
	})
	for _, path := range []string{"/", "/some/spa/route", "/movie/", "/movie/abc", "/movies/603"} {
		fetchHead(t, srv, path)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(asked) != 0 {
		t.Errorf("the graph was read for %v, which are not movie routes", asked)
	}
}

func TestSlugifyMatchesTheClient(t *testing.T) {
	// The cases are the ones in web/src/movieParam.test.ts: og:url has to
	// name the address the address bar settles on.
	for _, c := range []struct{ title, want string }{
		{"The Matrix", "the-matrix"},
		{"Ocean's Eleven", "oceans-eleven"},
		{"Amélie", "amelie"},
		{"9½ Weeks!", "91-2-weeks"},
		{"WALL·E", "wall-e"},
		{"", ""},
		{"!!!", ""},
	} {
		if got := slugify(c.title); got != c.want {
			t.Errorf("slugify(%q) = %q, want %q", c.title, got, c.want)
		}
	}
	long := strings.Repeat("a", 58) + " bb"
	if got := slugify(long); strings.HasSuffix(got, "-") || len(got) > 60 {
		t.Errorf("slugify(long) = %q, want no trailing hyphen and at most 60", got)
	}
}

func TestGenericPageStillHasAnAbsoluteURL(t *testing.T) {
	srv := previewServer(t, theMatrix)
	for _, path := range []string{"/", "/some/spa/route"} {
		if head := fetchHead(t, srv, path); !strings.Contains(head, `<meta property="og:url" content="https://cinedikt.com/" />`) {
			t.Errorf("GET %s left og:url relative", path)
		}
	}
}
