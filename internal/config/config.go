// Package config loads runtime settings from the environment.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/joho/godotenv"
)

// Environments this service knows about. Which one is running decides
// whether analytics reports anything; nothing else infers it from the
// shape of a URL or a log level.
const (
	EnvDevelopment = "development"
	EnvProduction  = "production"
)

// Config holds every setting shared by the crawler and the API.
type Config struct {
	// Environment is EnvDevelopment or EnvProduction, from APP_ENV. It is
	// explicit on purpose: guessing it from a hostname means a production
	// deploy that happens to reach its database over localhost silently
	// stops reporting.
	Environment string

	TMDBAPIKey      string
	TMDBAccessToken string
	// TMDBCacheTTL is the Redis TTL for raw TMDb responses.
	TMDBCacheTTL time.Duration
	// TMDBRatePerSecond caps outgoing TMDb requests; 0 means the client default.
	TMDBRatePerSecond float64
	// OMDBAPIKey enables IMDb rating lookups; empty disables them.
	OMDBAPIKey string
	// PostHog reporting. Only read in production.
	PostHogToken string
	PostHogHost  string
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

	// Limits on public traffic. Zero values take the API's defaults;
	// RATE_LIMIT_PER_SEC=0 explicitly disables per-client rate limiting.
	RateLimitPerSecond float64
	RateLimitBurst     int
	MaxColdCrawls      int
	// RateLimitDisabled records an explicit RATE_LIMIT_PER_SEC=0, which
	// means "off", not "use the default".
	RateLimitDisabled bool
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

	rateLimit, err := envFloat("RATE_LIMIT_PER_SEC")
	if err != nil {
		return Config{}, err
	}
	burst, err := envInt("RATE_LIMIT_BURST")
	if err != nil {
		return Config{}, err
	}
	coldCrawls, err := envInt("MAX_COLD_CRAWLS")
	if err != nil {
		return Config{}, err
	}

	env, err := environment()
	if err != nil {
		return Config{}, err
	}

	c := Config{
		Environment:       env,
		TMDBAPIKey:        os.Getenv("TMDB_API_KEY"),
		TMDBAccessToken:   os.Getenv("TMDB_ACCESS_TOKEN"),
		TMDBCacheTTL:      ttl,
		TMDBRatePerSecond: tmdbRate,
		OMDBAPIKey:        os.Getenv("OMDB_API_KEY"),
		PostHogToken:      os.Getenv("POSTHOG_PROJECT_TOKEN"),
		PostHogHost:       envOr("POSTHOG_HOST", "https://us.i.posthog.com"),
		RedisURL:          os.Getenv("REDIS_URL"),
		Neo4jURI:          envOr("NEO4J_URI", "bolt://localhost:7687"),
		Neo4jUser:         envOr("NEO4J_USER", "neo4j"),
		Neo4jPassword:     os.Getenv("NEO4J_PASSWORD"),
		APIAddr:           listenAddr(),
		WebDir:            os.Getenv("WEB_DIR"),

		CrawlThresholdBase: base,
		CrawlOrderPenalty:  penalty,

		RateLimitPerSecond: rateLimit,
		RateLimitBurst:     burst,
		MaxColdCrawls:      coldCrawls,
		RateLimitDisabled:  os.Getenv("RATE_LIMIT_PER_SEC") == "0",
	}
	if c.TMDBAPIKey == "" && c.TMDBAccessToken == "" {
		return Config{}, errors.New("config: set TMDB_API_KEY or TMDB_ACCESS_TOKEN")
	}
	if c.Neo4jPassword == "" {
		return Config{}, errors.New("config: set NEO4J_PASSWORD")
	}
	return c, nil
}

// Production reports whether this process is serving real traffic.
func (c Config) Production() bool { return c.Environment == EnvProduction }

// NewLogger builds the logger for this environment. In production it
// writes single-line JSON to stdout, which is what a log collector reads:
// Railway, for one, turns anything on stderr into an error, so plain text
// there makes every served request look like a failure and buries the
// real ones. JSON also hands `method`, `path`, `status` and the rest over
// as queryable fields rather than a string to grep. Locally it stays
// human-readable text on stderr, where a person is reading it.
//
// It takes the environment from APP_ENV directly, because a process needs
// a logger before it has finished loading its configuration — and before
// it can report that the configuration is wrong.
func NewLogger(level slog.Level) *slog.Logger {
	opts := &slog.HandlerOptions{Level: level}
	if env, err := environment(); err == nil && env == EnvProduction {
		return slog.New(slog.NewJSONHandler(os.Stdout, opts))
	}
	return slog.New(slog.NewTextHandler(os.Stderr, opts))
}

// environment reads APP_ENV. Unset means development, so a forgotten
// variable is quiet rather than chatty; a misspelt one is an error rather
// than a silent downgrade.
func environment() (string, error) {
	switch v := strings.ToLower(strings.TrimSpace(os.Getenv("APP_ENV"))); v {
	case "":
		return EnvDevelopment, nil
	case "dev", EnvDevelopment:
		return EnvDevelopment, nil
	case "prod", EnvProduction:
		return EnvProduction, nil
	default:
		return "", fmt.Errorf("config: APP_ENV=%q: want %q or %q", v, EnvDevelopment, EnvProduction)
	}
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

// envInt parses an optional integer variable; unset means 0.
func envInt(key string) (int, error) {
	v := os.Getenv(key)
	if v == "" {
		return 0, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("config: %s: %w", key, err)
	}
	return n, nil
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
