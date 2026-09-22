package api

import (
	"context"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/time/rate"
)

// Limits caps what one client may ask of a server whose endpoints crawl
// TMDb and write Neo4j on demand. Without them a single script walking
// movie ids exhausts the TMDb quota, fills the database, and queues every
// other reader behind its crawls.
type Limits struct {
	// RequestsPerSecond is the sustained per-client request rate; 0
	// disables rate limiting entirely (development).
	RequestsPerSecond float64
	// Burst is how many requests a client may make back to back. The map
	// opens several pathways at once, so this is well above the rate.
	Burst int
	// ColdCrawls is how many first-visit crawls may run at once across all
	// clients. It is the real protection: everything past it waits or is
	// turned away rather than piling onto TMDb.
	ColdCrawls int
	// SlotWait is how long a request waits for a cold-crawl slot before
	// it is turned away. Waiting longer would only deepen a queue the
	// client has already given up on. 0 takes DefaultLimits.SlotWait.
	SlotWait time.Duration
}

// DefaultLimits suit one small instance: generous for a person scrolling a
// map (which fires a handful of requests per screen), ruinous for a
// scraper.
var DefaultLimits = Limits{RequestsPerSecond: 5, Burst: 40, ColdCrawls: 8, SlotWait: 8 * time.Second}

// clientTTL is how long an idle client's limiter is kept; clientMax caps
// how many are held at once so the table cannot grow without bound.
const (
	clientTTL = 10 * time.Minute
	clientMax = 10_000
)

// ipLimiter is a token bucket per client address.
type ipLimiter struct {
	limit rate.Limit
	burst int
	now   func() time.Time

	mu      sync.Mutex
	clients map[string]*ipBucket
}

type ipBucket struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

func newIPLimiter(perSecond float64, burst int) *ipLimiter {
	if burst < 1 {
		burst = 1
	}
	return &ipLimiter{
		limit:   rate.Limit(perSecond),
		burst:   burst,
		now:     time.Now,
		clients: make(map[string]*ipBucket),
	}
}

// allow reports whether this client may make a request now.
func (l *ipLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	b, ok := l.clients[ip]
	if !ok {
		if len(l.clients) >= clientMax {
			l.sweep(now)
		}
		b = &ipBucket{limiter: rate.NewLimiter(l.limit, l.burst)}
		l.clients[ip] = b
	}
	b.lastSeen = now
	return b.limiter.AllowN(now, 1)
}

// sweep drops idle clients, and if none were idle, the whole table: a
// limiter lost this way costs one client a few extra tokens, which is
// cheaper than unbounded memory. Called with the lock held.
func (l *ipLimiter) sweep(now time.Time) {
	before := len(l.clients)
	for ip, b := range l.clients {
		if now.Sub(b.lastSeen) > clientTTL {
			delete(l.clients, ip)
		}
	}
	if len(l.clients) == before {
		clear(l.clients)
	}
}

// limitRate turns away clients over their rate with 429 and a Retry-After.
func (s *Server) limitRate(next http.Handler) http.Handler {
	if s.rate == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.rate.allow(clientIP(r)) {
			w.Header().Set("Retry-After", "1")
			writeError(w, http.StatusTooManyRequests, "too many requests")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// clientIP is the address the limiter counts against. Behind Railway the
// socket belongs to the edge proxy, which appends the address it saw to
// X-Forwarded-For, so the *last* entry is the real client. Reading the
// first entry instead would let a caller send its own X-Forwarded-For and
// rotate through fake addresses to shake off the limiter. Direct traffic
// has no such header and falls back to the socket.
func clientIP(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		if i := strings.LastIndex(fwd, ","); i >= 0 {
			return strings.TrimSpace(fwd[i+1:])
		}
		return strings.TrimSpace(fwd)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// crawlGate bounds how many cold crawls run at once and keeps readers
// ahead of the warmer: a background crawl only takes a slot when no
// reader is waiting for one.
type crawlGate struct {
	slots   chan struct{}
	waiting atomic.Int32
}

func newCrawlGate(n int) *crawlGate {
	if n < 1 {
		n = 1
	}
	return &crawlGate{slots: make(chan struct{}, n)}
}

// acquire takes a slot for a reader, waiting until one is free or ctx
// ends. Readers are counted while they wait so the warmer can stand aside.
func (g *crawlGate) acquire(ctx context.Context) error {
	g.waiting.Add(1)
	defer g.waiting.Add(-1)
	select {
	case g.slots <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// tryWarm takes a slot for a background crawl, but only if it is free
// right now and no reader is queued. It never blocks.
func (g *crawlGate) tryWarm() bool {
	if g.waiting.Load() > 0 {
		return false
	}
	select {
	case g.slots <- struct{}{}:
		return true
	default:
		return false
	}
}

func (g *crawlGate) release() { <-g.slots }

// retryAfterSeconds formats a Retry-After header value.
func retryAfterSeconds(d time.Duration) string {
	secs := int(d.Round(time.Second) / time.Second)
	if secs < 1 {
		secs = 1
	}
	return strconv.Itoa(secs)
}
