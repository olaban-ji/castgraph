package rediscache

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func TestMain(m *testing.M) {
	// The unreachable-server test makes the pool log its dial failures.
	redis.SetLogger(silentLogger{log.New(io.Discard, "", 0)})
	os.Exit(m.Run())
}

type silentLogger struct{ *log.Logger }

func (silentLogger) Printf(context.Context, string, ...any) {}

// newTestCache uses the Redis at REDIS_TEST_URL when set, else an
// in-process miniredis, so the test runs anywhere.
func newTestCache(t *testing.T, ttl time.Duration) (*Cache, func(d time.Duration)) {
	t.Helper()
	url := os.Getenv("REDIS_TEST_URL")
	advance := func(d time.Duration) { time.Sleep(d) }
	if url == "" {
		mr := miniredis.RunT(t)
		url = "redis://" + mr.Addr()
		advance = mr.FastForward
	}
	// A prefix unique to this run, wiped afterwards, so a shared Redis
	// never leaks state between runs.
	prefix := fmt.Sprintf("castgraph-test:%s:%d", t.Name(), time.Now().UnixNano())
	c, err := New(context.Background(), url, prefix, ttl)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		keys, _ := c.rdb.Keys(ctx, prefix+":*").Result()
		if len(keys) > 0 {
			c.rdb.Del(ctx, keys...)
		}
		c.Close()
	})
	return c, advance
}

func TestRoundTrip(t *testing.T) {
	c, _ := newTestCache(t, time.Hour)
	key := "/movie/603?append_to_response=credits"
	if _, ok := c.Get(key); ok {
		t.Fatal("hit before set")
	}
	if err := c.Set(key, []byte(`{"id":603}`)); err != nil {
		t.Fatal(err)
	}
	body, ok := c.Get(key)
	if !ok || string(body) != `{"id":603}` {
		t.Errorf("Get = %q, %v", body, ok)
	}
}

func TestEntriesExpire(t *testing.T) {
	c, advance := newTestCache(t, 50*time.Millisecond)
	if err := c.Set("tt0133093", []byte(`{}`)); err != nil {
		t.Fatal(err)
	}
	advance(100 * time.Millisecond)
	if _, ok := c.Get("tt0133093"); ok {
		t.Error("expired entry was served")
	}
}

func TestPrefixSeparatesNamespaces(t *testing.T) {
	mr := miniredis.RunT(t)
	url := "redis://" + mr.Addr()
	tmdb, err := New(context.Background(), url, "tmdb", 0)
	if err != nil {
		t.Fatal(err)
	}
	defer tmdb.Close()
	omdb, err := New(context.Background(), url, "omdb", 0)
	if err != nil {
		t.Fatal(err)
	}
	defer omdb.Close()
	if err := tmdb.Set("k", []byte("a")); err != nil {
		t.Fatal(err)
	}
	if _, ok := omdb.Get("k"); ok {
		t.Error("key leaked across prefixes")
	}
}

func TestBadURLAndUnreachable(t *testing.T) {
	if _, err := New(context.Background(), "not a url", "x", 0); err == nil {
		t.Error("New(bad url): want error")
	}
	if _, err := New(context.Background(), "redis://127.0.0.1:1", "x", 0); err == nil {
		t.Error("New(unreachable): want error")
	}
}

func TestClosedCacheMisses(t *testing.T) {
	c, _ := newTestCache(t, 0)
	c.Close()
	if _, ok := c.Get("k"); ok {
		t.Error("closed cache returned a hit")
	}
	if err := c.Set("k", []byte("v")); err == nil {
		t.Error("Set on closed cache: want error")
	}
}
