package main

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
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
	srv := httptest.NewServer(routes(api, dir, slog.New(slog.NewTextHandler(io.Discard, nil))))
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
	srv := httptest.NewServer(routes(api, dir, slog.New(slog.NewTextHandler(io.Discard, nil))))
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
	srv := httptest.NewServer(routes(api, dir, slog.New(slog.NewTextHandler(io.Discard, nil))))
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
