// Package rediscache stores raw HTTP response bodies in Redis with a TTL.
// It is the shared cache for the TMDb and OMDb clients.
package rediscache

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// Cache satisfies the tmdb and omdb Cache interfaces.
type Cache struct {
	rdb    *redis.Client
	prefix string
	ttl    time.Duration
	// timeout bounds each Redis call so a slow cache never holds up a
	// crawl; a miss is always a safe answer.
	timeout time.Duration
}

// New connects to the Redis at url (redis://[:password@]host:port[/db]),
// verifies it answers, and namespaces every key with prefix. A zero TTL
// never expires; a size cap belongs to Redis (maxmemory-policy allkeys-lru).
func New(ctx context.Context, url, prefix string, ttl time.Duration) (*Cache, error) {
	opts, err := redis.ParseURL(url)
	if err != nil {
		return nil, fmt.Errorf("rediscache: %w", err)
	}
	rdb := redis.NewClient(opts)
	if err := rdb.Ping(ctx).Err(); err != nil {
		rdb.Close()
		return nil, fmt.Errorf("rediscache: connect %s: %w", opts.Addr, err)
	}
	return &Cache{rdb: rdb, prefix: prefix + ":", ttl: ttl, timeout: 2 * time.Second}, nil
}

// Get returns the cached body for key, if present. Any Redis error counts
// as a miss.
func (c *Cache) Get(key string) ([]byte, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), c.timeout)
	defer cancel()
	body, err := c.rdb.Get(ctx, c.prefix+key).Bytes()
	if err != nil {
		return nil, false
	}
	return body, true
}

// Set stores body under key for the cache's TTL.
func (c *Cache) Set(key string, body []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), c.timeout)
	defer cancel()
	if err := c.rdb.Set(ctx, c.prefix+key, body, c.ttl).Err(); err != nil {
		return fmt.Errorf("rediscache: set %s: %w", key, err)
	}
	return nil
}

// Ping reports whether Redis is reachable. It backs the API's health
// check; a cache that is down degrades the service rather than breaking
// it, so callers decide what to do about a failure.
func (c *Cache) Ping(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	if err := c.rdb.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("rediscache: ping: %w", err)
	}
	return nil
}

// Close releases the connection pool.
func (c *Cache) Close() error {
	if err := c.rdb.Close(); err != nil && !errors.Is(err, redis.ErrClosed) {
		return err
	}
	return nil
}
