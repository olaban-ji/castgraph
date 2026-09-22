package api

import (
	"context"
	"log/slog"
	"runtime/debug"
	"time"

	"cinedikt/internal/seen"
)

// warmer crawls movies in the background so that when a client asks for
// their pathways the answer comes from Neo4j in milliseconds instead of
// from TMDb in seconds. It is fed with the films a pathways response just
// handed out: the client's next hop, in every direction.
//
// Two rules keep it from ever costing a reader anything. Enqueueing is
// pure memory — no database call happens on the request path — and a
// worker only crawls when the cold-crawl gate has a slot going spare,
// putting the film back on the queue rather than waiting for one.
type warmer struct {
	reader   Reader
	expander Expander
	gate     *crawlGate
	logger   *slog.Logger
	queue    chan int
	// queued is bounded and expiring so a long-lived server neither
	// remembers every id forever nor refuses to ever warm one again.
	queued *seen.Set
}

const (
	// warmQueueSize bounds how far ahead of the reader the warmer can get.
	warmQueueSize = 256
	// warmMemory is how long a warmed film is remembered as done.
	warmMemory = 6 * time.Hour
	// warmBackoff is how long a worker waits after finding the gate busy,
	// so a stream of readers does not become a spin loop.
	warmBackoff = 250 * time.Millisecond
	// warmTimeout bounds one background crawl, so a stalled TMDb or Neo4j
	// cannot park a worker for the life of the process.
	warmTimeout = 60 * time.Second
	// warmCheckTimeout bounds the "was it crawled already?" query.
	warmCheckTimeout = 5 * time.Second
)

func newWarmer(reader Reader, expander Expander, gate *crawlGate, logger *slog.Logger) *warmer {
	return &warmer{
		reader:   reader,
		expander: expander,
		gate:     gate,
		logger:   logger,
		queue:    make(chan int, warmQueueSize),
		queued:   seen.New(warmQueueSize*8, warmMemory),
	}
}

// run drains the queue with n workers until ctx ends.
func (w *warmer) run(ctx context.Context, n int) {
	for range n {
		go w.work(ctx)
	}
}

func (w *warmer) work(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case id := <-w.queue:
			w.handle(ctx, id)
		}
	}
}

// handle crawls one film if the gate allows it, and otherwise puts it
// back for later: a worker never holds an id hostage while readers work.
func (w *warmer) handle(ctx context.Context, id int) {
	defer func() {
		if v := recover(); v != nil {
			w.logger.Error("warm panic recovered", "movie", id,
				"panic", v, "stack", string(debug.Stack()))
			w.queued.Forget(id)
		}
	}()
	if !w.gate.tryWarm() {
		w.requeue(ctx, id)
		return
	}
	defer w.gate.release()
	w.warm(ctx, id)
}

// requeue returns an id to the back of the queue after a short pause. If
// the queue is full the id is forgotten instead, so a later pathways
// response can offer it again.
func (w *warmer) requeue(ctx context.Context, id int) {
	select {
	case <-ctx.Done():
		return
	case <-time.After(warmBackoff):
	}
	select {
	case w.queue <- id:
	default:
		w.queued.Forget(id)
	}
}

// enqueue schedules films for warming. It does no I/O: the request that
// produced these ids is about to be answered, and a Neo4j round trip per
// candidate would be latency the reader pays for the next reader's
// benefit. Whether a film is already crawled is checked by the worker.
func (w *warmer) enqueue(ids []int) {
	for _, id := range ids {
		if !w.queued.Add(id) {
			continue
		}
		select {
		case w.queue <- id:
		default:
			// Queue full: the warmer is already further ahead than the
			// reader can consume. Forget the id so it can come back.
			w.queued.Forget(id)
			return
		}
	}
}

func (w *warmer) warm(ctx context.Context, id int) {
	checkCtx, cancelCheck := context.WithTimeout(ctx, warmCheckTimeout)
	crawled, err := w.reader.MovieCrawled(checkCtx, id)
	cancelCheck()
	if err != nil {
		w.logger.Debug("warm check failed", "movie", id, "err", err)
		w.queued.Forget(id)
		return
	}
	if crawled {
		return
	}

	crawlCtx, cancel := context.WithTimeout(ctx, warmTimeout)
	defer cancel()
	start := time.Now()
	if _, err := w.expander.ExpandMovie(crawlCtx, id, 1); err != nil {
		w.logger.Warn("warm failed", "movie", id, "err", err)
		w.queued.Forget(id) // let a later request try again
		return
	}
	w.logger.Debug("warmed", "movie", id, "duration", time.Since(start).Round(time.Millisecond))
}
