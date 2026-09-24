// Command api serves the movie network over HTTP.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"cinedikt/internal/analytics"
	"cinedikt/internal/api"
	"cinedikt/internal/app"
	"cinedikt/internal/config"
)

// warmWorkers is how many background crawls run alongside requests.
const warmWorkers = 3

// Server timeouts. RequestTimeout is the budget a handler gets: long
// enough for a cold crawl to wait for a slot (SlotTimeout) and finish
// (SeedTimeout), short enough that a stuck dependency frees the
// connection. The rest are backstops for clients that stop reading.
const (
	requestTimeout    = 40 * time.Second
	readHeaderTimeout = 10 * time.Second
	readTimeout       = 15 * time.Second
	writeTimeout      = 60 * time.Second
	idleTimeout       = 120 * time.Second
)

func main() {
	level := slog.LevelInfo
	if os.Getenv("LOG_LEVEL") == "debug" {
		level = slog.LevelDebug
	}
	logger := config.NewLogger(level)
	if err := run(logger); err != nil {
		logger.Error("api failed", "err", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if err := analytics.Init(analytics.Config{
		Production: cfg.Production(),
		Token:      cfg.PostHogToken,
		Host:       cfg.PostHogHost,
	}, logger); err != nil {
		return err
	}
	logger = analytics.Logger(logger, "cinedikt-api")
	logger.Info("starting", "environment", cfg.Environment, "addr", cfg.APIAddr)
	defer func() {
		if err := analytics.Close(); err != nil {
			logger.Error("close PostHog client", "err", err)
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Crawls happen inside requests and in the warmer; keep TMDb busy, but
	// only fetch the filmographies the map can use (lead + anchorCostars).
	a, err := app.New(ctx, cfg, 16, 8, logger)
	if err != nil {
		return err
	}
	defer a.Close(context.Background())

	server := api.NewWithLimits(a.Store, a.Crawler, a.TMDB, limits(cfg), logger)
	if cfg.Production() {
		// The map reports only when this process does, so a development
		// build served from a LAN address cannot quietly send events.
		server.WithAnalytics(api.AnalyticsConfig{Token: cfg.PostHogToken, Host: cfg.PostHogHost})
	}
	server.WithHealth(health(a)...)
	server.WithFirstRun(a.Store)
	// Off the startup path: the scan takes a moment and nothing should
	// wait on it, least of all the health check.
	go server.WarmFirstRun(ctx)
	server.StartWarming(ctx, warmWorkers)
	srv := &http.Server{
		Addr:              cfg.APIAddr,
		Handler:           routes(server.Handler(), cfg.WebDir, logger),
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
	}

	errc := make(chan error, 1)
	go func() {
		logger.Info("listening", "addr", cfg.APIAddr)
		errc <- srv.ListenAndServe()
	}()

	select {
	case err := <-errc:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	}
}

// limits applies any environment overrides to the API's defaults.
func limits(cfg config.Config) api.Limits {
	l := api.DefaultLimits
	if cfg.RateLimitDisabled {
		l.RequestsPerSecond = 0
	} else if cfg.RateLimitPerSecond > 0 {
		l.RequestsPerSecond = cfg.RateLimitPerSecond
	}
	if cfg.RateLimitBurst > 0 {
		l.Burst = cfg.RateLimitBurst
	}
	if cfg.MaxColdCrawls > 0 {
		l.ColdCrawls = cfg.MaxColdCrawls
	}
	return l
}

// health adapts the app's dependencies to the API's health check.
func health(a *app.App) []api.Dependency {
	deps := a.Dependencies()
	out := make([]api.Dependency, 0, len(deps))
	for _, d := range deps {
		out = append(out, api.Dependency{Name: d.Name, Ping: d.Ping})
	}
	return out
}

// routes mounts the API at /api and, when webDir is set, the built
// frontend at / (with index.html for any path it does not have, so the
// app's own URLs work on reload). Without webDir the API also answers at /
// so curl examples keep working.
func routes(apiHandler http.Handler, webDir string, logger *slog.Logger) http.Handler {
	// Every API handler runs under a deadline, so a stalled dependency
	// ends as a 503 rather than a connection held until the client or
	// the platform gives up.
	apiHandler = withTimeout(apiHandler, requestTimeout)
	mux := http.NewServeMux()
	mux.Handle("/api/", http.StripPrefix("/api", apiHandler))
	if webDir == "" {
		mux.Handle("/", apiHandler)
	} else {
		if _, err := os.Stat(filepath.Join(webDir, "index.html")); err != nil {
			logger.Warn("WEB_DIR has no index.html; build the frontend with `npm run build` in web/", "dir", webDir)
		}
		files := http.FileServer(http.Dir(webDir))
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			// Maps used to live at /film/. Links to them are out in the
			// world for good, so they are moved rather than served: one
			// address per map, and the one people see is the new one.
			if to, ok := movieRoute(r.URL); ok {
				http.Redirect(w, r, to, http.StatusMovedPermanently)
				return
			}
			p := filepath.Join(webDir, filepath.FromSlash(strings.TrimPrefix(r.URL.Path, "/")))
			if info, err := os.Stat(p); err == nil && !info.IsDir() {
				setWebCache(w, hashedAsset(r.URL.Path))
				files.ServeHTTP(w, r)
				return
			}
			setWebCache(w, false)
			serveIndex(w, r, filepath.Join(webDir, "index.html"))
		})
		logger.Info("serving frontend", "dir", webDir)
	}
	return recoverPanics(mux, logger)
}

// movieRoute is where an old /film/ link should go, query and all.
func movieRoute(u *url.URL) (string, bool) {
	rest, ok := strings.CutPrefix(u.Path, "/film/")
	if !ok || rest == "" {
		return "", false
	}
	to := "/movie/" + rest
	if u.RawQuery != "" {
		to += "?" + u.RawQuery
	}
	return to, true
}

// withTimeout gives each request a deadline its handlers can observe.
func withTimeout(next http.Handler, d time.Duration) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), d)
		defer cancel()
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// Vite fingerprints JS/CSS under /assets/; those URLs never reuse a
// body, so they can be cached for a year. index.html (and anything else)
// must revalidate so a deploy's new asset hashes are picked up.
const (
	assetCacheControl = "public, max-age=31536000, immutable"
	htmlCacheControl  = "no-cache"
)

func hashedAsset(urlPath string) bool {
	return strings.HasPrefix(urlPath, "/assets/")
}

// ogImagePath is the share card. Link unfurlers refuse a relative URL
// and will not draw SVG, so index.html's og:image and twitter:image
// tags are rewritten to an absolute PNG URL for the host that was
// fetched. Whatever follows the path is kept: the ?v= is how a new card
// reaches an unfurler that is still holding the old one.
const ogImagePath = "/og.png"

var ogImageTag = regexp.MustCompile(`content="` + regexp.QuoteMeta(ogImagePath) + `([^"]*)"`)

func serveIndex(w http.ResponseWriter, r *http.Request, path string) {
	body, err := os.ReadFile(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if origin := requestOrigin(r); origin != "" {
		abs := []byte(`content="` + origin + ogImagePath)
		body = ogImageTag.ReplaceAllFunc(body, func(tag []byte) []byte {
			// The host is already known safe, and the tail is copied
			// across as it stands, so no expansion runs over either.
			return append(append([]byte{}, abs...), tag[len(`content="`+ogImagePath):]...)
		})
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(body)
}

// requestOrigin is the public scheme and host. Railway terminates TLS,
// so the scheme comes from X-Forwarded-Proto rather than r.TLS.
func requestOrigin(r *http.Request) string {
	proto := headerFirst(r, "X-Forwarded-Proto")
	if proto != "https" && proto != "http" {
		if r.TLS != nil {
			proto = "https"
		} else {
			proto = "http"
		}
	}
	host := headerFirst(r, "X-Forwarded-Host")
	if host == "" {
		host = r.Host
	}
	if !safeHost(host) {
		return ""
	}
	return proto + "://" + host
}

func headerFirst(r *http.Request, name string) string {
	v := r.Header.Get(name)
	if i := strings.IndexByte(v, ','); i >= 0 {
		v = v[:i]
	}
	return strings.TrimSpace(v)
}

func safeHost(host string) bool {
	if host == "" || len(host) > 253 {
		return false
	}
	for _, c := range host {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '.', c == '-', c == ':':
		default:
			return false
		}
	}
	return true
}

func setWebCache(w http.ResponseWriter, hashed bool) {
	if hashed {
		w.Header().Set("Cache-Control", assetCacheControl)
		return
	}
	w.Header().Set("Cache-Control", htmlCacheControl)
}

// recoverPanics is the API's single global panic boundary. Its error log is
// handled by analytics.Logger, which sends the exception to PostHog.
func recoverPanics(next http.Handler, logger *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				logger.Error("unhandled request panic", "error", fmt.Errorf("%v", recovered))
				http.Error(w, "internal server error", http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}
