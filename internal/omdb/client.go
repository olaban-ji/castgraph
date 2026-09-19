// Package omdb fetches IMDb ratings from the OMDb API (omdbapi.com), the
// only free source for them; TMDb carries its own score, not IMDb's.
package omdb

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

const defaultBaseURL = "https://www.omdbapi.com/"

// ErrNotFound is returned when OMDb has no entry, or no rating, for an id.
var ErrNotFound = errors.New("omdb: not found")

// ErrQuota is returned once OMDb has reported the daily request limit;
// the client then stops calling out for QuotaPause.
var ErrQuota = errors.New("omdb: daily request limit reached")

// QuotaPause is how long lookups are skipped after a quota error. OMDb's
// free quota resets daily; an hour keeps a long-running server from
// spending the whole day being told no.
const QuotaPause = time.Hour

// Cache stores raw response bodies keyed by IMDb id.
type Cache interface {
	Get(key string) ([]byte, bool)
	Set(key string, body []byte) error
}

type noCache struct{}

func (noCache) Get(string) ([]byte, bool) { return nil, false }
func (noCache) Set(string, []byte) error  { return nil }

// Rating is IMDb's user rating for a title.
type Rating struct {
	Value float64 // 0–10
	Votes int
}

// Client looks up titles by IMDb id. The free tier allows 1,000 requests a
// day, so callers should cache and look up only what they will show.
type Client struct {
	http    *http.Client
	baseURL string
	apiKey  string
	limiter *rate.Limiter
	cache   Cache
	now     func() time.Time

	mu         sync.Mutex
	pausedTill time.Time
}

// Option configures a Client.
type Option func(*Client)

// WithBaseURL points the client at a different server (used by tests).
func WithBaseURL(u string) Option { return func(c *Client) { c.baseURL = u } }

// WithCache stores successful responses in cache and serves repeats from it.
func WithCache(cache Cache) Option { return func(c *Client) { c.cache = cache } }

// New returns a client with a gentle 5 requests/second limit.
func New(apiKey string, opts ...Option) *Client {
	c := &Client{
		http:    &http.Client{Timeout: 15 * time.Second},
		baseURL: defaultBaseURL,
		apiKey:  apiKey,
		limiter: rate.NewLimiter(5, 5),
		cache:   noCache{},
		now:     time.Now,
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// IMDbRating returns the IMDb rating for an IMDb id such as "tt0133093".
func (c *Client) IMDbRating(ctx context.Context, imdbID string) (Rating, error) {
	if body, ok := c.cache.Get(imdbID); ok {
		return parse(body)
	}
	if c.paused() {
		return Rating{}, ErrQuota
	}
	body, err := c.fetch(ctx, imdbID)
	if err != nil {
		return Rating{}, err
	}
	r, err := parse(body)
	if errors.Is(err, ErrQuota) {
		c.pause()
		return Rating{}, err
	}
	if err != nil && !errors.Is(err, ErrNotFound) {
		// Key problems and the like are transient; never cache them.
		return Rating{}, err
	}
	// Cache "not found" too: those ids would otherwise be re-queried on
	// every crawl and eat the daily quota.
	if cerr := c.cache.Set(imdbID, body); cerr != nil {
		return Rating{}, fmt.Errorf("omdb: cache %s: %w", imdbID, cerr)
	}
	return r, err
}

func (c *Client) paused() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now().Before(c.pausedTill)
}

func (c *Client) pause() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.pausedTill = c.now().Add(QuotaPause)
}

func (c *Client) fetch(ctx context.Context, imdbID string) ([]byte, error) {
	if err := c.limiter.Wait(ctx); err != nil {
		return nil, err
	}
	q := url.Values{"i": {imdbID}, "apikey": {c.apiKey}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("omdb: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("omdb: read %s: %w", imdbID, err)
	}
	// OMDb reports most failures (bad key, quota, unknown id) as a 200
	// with Response:"False"; parse handles those. Anything else is transport.
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusUnauthorized {
		return nil, fmt.Errorf("omdb: HTTP %d for %s", resp.StatusCode, imdbID)
	}
	return body, nil
}

// parse reads OMDb's envelope. Ratings arrive as strings ("8.7",
// "2,081,234") or "N/A".
func parse(body []byte) (Rating, error) {
	var env struct {
		Response   string `json:"Response"`
		Error      string `json:"Error"`
		IMDbRating string `json:"imdbRating"`
		IMDbVotes  string `json:"imdbVotes"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		return Rating{}, fmt.Errorf("omdb: decode: %w", err)
	}
	if env.Response != "True" {
		switch {
		case strings.Contains(env.Error, "not found"):
			return Rating{}, ErrNotFound
		case strings.Contains(env.Error, "limit reached"):
			return Rating{}, ErrQuota
		}
		return Rating{}, fmt.Errorf("omdb: %s", env.Error)
	}
	if env.IMDbRating == "" || env.IMDbRating == "N/A" {
		return Rating{}, ErrNotFound
	}
	value, err := strconv.ParseFloat(env.IMDbRating, 64)
	if err != nil {
		return Rating{}, fmt.Errorf("omdb: rating %q: %w", env.IMDbRating, err)
	}
	votes, _ := strconv.Atoi(strings.ReplaceAll(env.IMDbVotes, ",", ""))
	return Rating{Value: value, Votes: votes}, nil
}
