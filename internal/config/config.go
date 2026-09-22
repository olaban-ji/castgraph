// Package config loads runtime settings from the environment.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/joho/godotenv"
)

// Config holds every setting shared by the crawler and the API.
type Config struct {
	TMDBAPIKey      string
	TMDBAccessToken string
	// TMDBCacheTTL is the Redis TTL for raw TMDb responses.
	TMDBCacheTTL time.Duration
	// TMDBRatePerSecond caps outgoing TMDb requests; 0 means the client default.
	TMDBRatePerSecond float64
	// OMDBAPIKey enables IMDb rating lookups; empty disables them.
	OMDBAPIKey string
	// RedisURL, if set, holds the TMDb/OMDb response cache.
	RedisURL string

	Neo4jURI      string
	Neo4jUser     string
	Neo4jPassword string

	// Crawl scoring; zero values mean the crawler's defaults.
	CrawlThresholdBase float64
	CrawlOrderPenalty  float64

	APIAddr string
	// WebDir, if set, is a built frontend (web/dist) served at / with the
	// API under /api.
	WebDir string
}

// Load reads a .env file if present, then the environment.
func Load() (Config, error) {
	// A missing .env is fine; the environment alone may be complete.
	_ = godotenv.Load()

	ttl, err := time.ParseDuration(envOr("TMDB_CACHE_TTL", "168h"))
	if err != nil {
		return Config{}, fmt.Errorf("config: TMDB_CACHE_TTL: %w", err)
	}

	tmdbRate, err := envFloat("TMDB_RATE_PER_SEC")
	if err != nil {
		return Config{}, err
	}
	base, err := envFloat("CRAWL_THRESHOLD_BASE")
	if err != nil {
		return Config{}, err
	}
	penalty, err := envFloat("CRAWL_ORDER_PENALTY")
	if err != nil {
		return Config{}, err
	}

	c := Config{
		TMDBAPIKey:        os.Getenv("TMDB_API_KEY"),
		TMDBAccessToken:   os.Getenv("TMDB_ACCESS_TOKEN"),
		TMDBCacheTTL:      ttl,
		TMDBRatePerSecond: tmdbRate,
		OMDBAPIKey:        os.Getenv("OMDB_API_KEY"),
		RedisURL:          os.Getenv("REDIS_URL"),
		Neo4jURI:          envOr("NEO4J_URI", "bolt://localhost:7687"),
		Neo4jUser:         envOr("NEO4J_USER", "neo4j"),
		Neo4jPassword:     os.Getenv("NEO4J_PASSWORD"),
		APIAddr:           listenAddr(),
		WebDir:            os.Getenv("WEB_DIR"),

		CrawlThresholdBase: base,
		CrawlOrderPenalty:  penalty,
	}
	if c.TMDBAPIKey == "" && c.TMDBAccessToken == "" {
		return Config{}, errors.New("config: set TMDB_API_KEY or TMDB_ACCESS_TOKEN")
	}
	if c.Neo4jPassword == "" {
		return Config{}, errors.New("config: set NEO4J_PASSWORD")
	}
	return c, nil
}

// envFloat parses an optional float variable; unset means 0.
func envFloat(key string) (float64, error) {
	v := os.Getenv(key)
	if v == "" {
		return 0, nil
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return 0, fmt.Errorf("config: %s: %w", key, err)
	}
	return f, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// listenAddr prefers API_ADDR, then Railway/Fly-style PORT, then :8080.
func listenAddr() string {
	if v := os.Getenv("API_ADDR"); v != "" {
		return v
	}
	if p := os.Getenv("PORT"); p != "" {
		if strings.HasPrefix(p, ":") {
			return p
		}
		return ":" + p
	}
	return ":8080"
}
