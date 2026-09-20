// Command crawler seeds the graph from one TMDb movie.
//
// Usage:
//
//	crawler -movie 603 [-depth 1] [-concurrency 8] [-v]
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"cinedikt/internal/app"
	"cinedikt/internal/config"
)

func main() {
	movieID := flag.Int("movie", 0, "TMDb id of the seed movie (required)")
	depth := flag.Int("depth", 1, "levels to expand; 1 = seed cast and their filmographies")
	concurrency := flag.Int("concurrency", 8, "TMDb requests in flight at once")
	verbose := flag.Bool("v", false, "log every node written")
	flag.Parse()
	if *movieID <= 0 {
		flag.Usage()
		os.Exit(2)
	}

	level := slog.LevelInfo
	if *verbose {
		level = slog.LevelDebug
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))

	if err := run(*movieID, *depth, *concurrency, logger); err != nil {
		logger.Error("crawl failed", "err", err)
		os.Exit(1)
	}
}

func run(movieID, depth, concurrency int, logger *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	a, err := app.New(ctx, cfg, concurrency, 0, logger)
	if err != nil {
		return err
	}
	defer a.Close(context.Background())

	start := time.Now()
	stats, err := a.Crawler.Run(ctx, movieID, depth)
	if err != nil {
		return err
	}
	fmt.Printf("done in %s: %d movies, %d people written, %d people skipped by scoring, %d fetch errors, %d rating errors, %d write errors\n",
		time.Since(start).Round(time.Millisecond), stats.MoviesFetched, stats.PeopleFetched,
		stats.PeopleSkipped, stats.FetchErrors, stats.RatingErrors, stats.WriteErrors)
	return nil
}
