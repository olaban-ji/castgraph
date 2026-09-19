// Command api serves the movie network over HTTP.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"castgraph/internal/api"
	"castgraph/internal/app"
	"castgraph/internal/config"
)

// warmWorkers is how many background crawls run alongside requests.
const warmWorkers = 3

func main() {
	level := slog.LevelInfo
	if os.Getenv("LOG_LEVEL") == "debug" {
		level = slog.LevelDebug
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
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
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Crawls happen inside requests and in the warmer; keep TMDb busy, but
	// only fetch the filmographies the map can use (lead + anchorCostars).
	a, err := app.New(ctx, cfg, 16, 8, logger)
	if err != nil {
		return err
	}
	defer a.Close(context.Background())

	server := api.New(a.Store, a.Crawler, a.TMDB, logger)
	server.StartWarming(ctx, warmWorkers)
	srv := &http.Server{
		Addr:              cfg.APIAddr,
		Handler:           routes(server.Handler(), cfg.WebDir, logger),
		ReadHeaderTimeout: 10 * time.Second,
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

// routes mounts the API at /api and, when webDir is set, the built
// frontend at / (with index.html for any path it does not have, so the
// app's own URLs work on reload). Without webDir the API also answers at /
// so curl examples keep working.
func routes(apiHandler http.Handler, webDir string, logger *slog.Logger) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/api/", http.StripPrefix("/api", apiHandler))
	if webDir == "" {
		mux.Handle("/", apiHandler)
		return mux
	}
	if _, err := os.Stat(filepath.Join(webDir, "index.html")); err != nil {
		logger.Warn("WEB_DIR has no index.html; build the frontend with `npm run build` in web/", "dir", webDir)
	}
	files := http.FileServer(http.Dir(webDir))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		p := filepath.Join(webDir, filepath.FromSlash(strings.TrimPrefix(r.URL.Path, "/")))
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			files.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(webDir, "index.html"))
	})
	logger.Info("serving frontend", "dir", webDir)
	return mux
}
