package api

import (
	"context"
	"strconv"
	"sync/atomic"
	"time"
)

// Limits caps how many first-visit crawls the old graph path may run at
// once. A catalog request never crawls, so it is not touched by this.
type Limits struct {
	// ColdCrawls is how many first-visit crawls may run at once across all
	// clients. Everything past it waits or is turned away rather than
	// piling onto TMDb.
	ColdCrawls int
	// SlotWait is how long a request waits for a cold-crawl slot before
	// it is turned away. Waiting longer would only deepen a queue the
	// client has already given up on. 0 takes DefaultLimits.SlotWait.
	SlotWait time.Duration
}

// DefaultLimits suit one small instance crawling TMDb on a first visit.
var DefaultLimits = Limits{ColdCrawls: 8, SlotWait: 8 * time.Second}

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
