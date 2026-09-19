package api

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

// warmer crawls movies in the background so that when a client asks for
// their pathways the answer comes from Neo4j in milliseconds instead of
// from TMDb in seconds. It is fed with the films a pathways response just
// handed out: the client's next hop, in every direction.
type warmer struct {
	reader   Reader
	expander Expander
	logger   *slog.Logger
	queue    chan int
	queued   sync.Map // movie id -> struct{}
	// busy counts crawls that a client is waiting on right now; workers
	// hold back while it is non-zero so warming never slows a reader.
	busy atomic.Int32
}

// warmQueueSize bounds how far ahead of the reader the warmer can get.
const warmQueueSize = 256

func newWarmer(reader Reader, expander Expander, logger *slog.Logger) *warmer {
	return &warmer{reader: reader, expander: expander, logger: logger, queue: make(chan int, warmQueueSize)}
}

// run drains the queue with n workers until ctx ends.
func (w *warmer) run(ctx context.Context, n int) {
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case id := <-w.queue:
					w.waitForIdle(ctx)
					w.warm(ctx, id)
				}
			}
		}()
	}
	wg.Wait()
}

// enqueue schedules movies that have not been crawled. It never blocks:
// when the queue is full the movie is simply not warmed and will be
// crawled on demand instead.
func (w *warmer) enqueue(ctx context.Context, ids []int) {
	for _, id := range ids {
		if _, dup := w.queued.LoadOrStore(id, struct{}{}); dup {
			continue
		}
		if crawled, err := w.reader.MovieCrawled(ctx, id); err != nil || crawled {
			continue
		}
		select {
		case w.queue <- id:
		default:
			w.queued.Delete(id)
			return
		}
	}
}

// waitForIdle blocks while a client is waiting on a crawl.
func (w *warmer) waitForIdle(ctx context.Context) {
	for w.busy.Load() > 0 {
		select {
		case <-ctx.Done():
			return
		case <-time.After(50 * time.Millisecond):
		}
	}
}

func (w *warmer) warm(ctx context.Context, id int) {
	start := time.Now()
	if _, err := w.expander.ExpandMovie(ctx, id, 1); err != nil {
		w.logger.Warn("warm failed", "movie", id, "err", err)
		w.queued.Delete(id) // let a later request try again
		return
	}
	w.logger.Debug("warmed", "movie", id, "duration", time.Since(start).Round(time.Millisecond))
}
