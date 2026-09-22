package api

import (
	"context"
	"testing"
	"time"
)

func TestEnqueueDoesNoDatabaseWork(t *testing.T) {
	reader := &fakeReader{crawled: map[int]bool{}}
	w := newWarmer(reader, &fakeExpander{reader: reader}, newCrawlGate(1), discardLogger())

	w.enqueue([]int{1, 2, 3, 4})

	if got := reader.checks(); got != 0 {
		t.Errorf("enqueue made %d database calls; it runs on the request path and must make none", got)
	}
	if got := len(w.queue); got != 4 {
		t.Errorf("queued %d films, want 4", got)
	}
	// Films already queued are not queued twice.
	w.enqueue([]int{1, 2})
	if got := len(w.queue); got != 4 {
		t.Errorf("queued %d films after repeats, want 4", got)
	}
}

func TestEnqueueDropsFilmsWhenTheQueueIsFull(t *testing.T) {
	reader := &fakeReader{crawled: map[int]bool{}}
	w := newWarmer(reader, &fakeExpander{reader: reader}, newCrawlGate(1), discardLogger())

	ids := make([]int, warmQueueSize+10)
	for i := range ids {
		ids[i] = i + 1
	}
	w.enqueue(ids) // must not block
	if got := len(w.queue); got != warmQueueSize {
		t.Errorf("queue holds %d, want its cap of %d", got, warmQueueSize)
	}
	// A dropped film is forgotten, so a later response can offer it again.
	if !w.queued.Add(ids[len(ids)-1]) {
		t.Error("a film dropped for want of space was remembered as queued")
	}
}

func TestWarmerWaitsForReadersAndThenCatchesUp(t *testing.T) {
	reader := &fakeReader{crawled: map[int]bool{}}
	expander := &fakeExpander{reader: reader}
	gate := newCrawlGate(1)
	w := newWarmer(reader, expander, gate, discardLogger())

	// A reader holds the only crawl slot.
	if err := gate.acquire(context.Background()); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w.run(ctx, 1)
	w.enqueue([]int{42})

	// While the reader holds the slot, nothing is warmed.
	time.Sleep(3 * warmBackoff)
	if got := expander.count(); got != 0 {
		t.Fatalf("warmed %d films while a reader held the crawl slot, want 0", got)
	}

	// Once the reader is done, the film is still queued and gets warmed.
	gate.release()
	waitFor(t, 2*time.Second, func() bool { return expander.count() == 1 })
}

func TestWarmerSkipsFilmsAlreadyCrawled(t *testing.T) {
	reader := &fakeReader{crawled: map[int]bool{7: true}}
	expander := &fakeExpander{reader: reader}
	w := newWarmer(reader, expander, newCrawlGate(1), discardLogger())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w.run(ctx, 1)
	w.enqueue([]int{7})

	waitFor(t, time.Second, func() bool { return reader.checks() > 0 })
	time.Sleep(50 * time.Millisecond)
	if got := expander.count(); got != 0 {
		t.Errorf("crawled %d films that were already in the graph, want 0", got)
	}
}

func TestCrawlGateKeepsReadersAheadOfWarming(t *testing.T) {
	gate := newCrawlGate(2)

	if !gate.tryWarm() {
		t.Fatal("tryWarm on an idle gate = false, want true")
	}
	if err := gate.acquire(context.Background()); err != nil {
		t.Fatal(err)
	}
	// Both slots are taken: a background crawl cannot have one.
	if gate.tryWarm() {
		t.Error("tryWarm on a full gate = true, want false")
	}

	// A reader waiting for a slot also holds the warmer off, even once a
	// slot frees, so warming never jumps the queue.
	waiting := make(chan error, 1)
	go func() { waiting <- gate.acquire(context.Background()) }()
	waitFor(t, time.Second, func() bool { return gate.waiting.Load() > 0 })
	if gate.tryWarm() {
		t.Error("tryWarm while a reader is queued = true, want false")
	}
	gate.release()
	if err := <-waiting; err != nil {
		t.Fatalf("queued reader: %v", err)
	}
	gate.release()
	gate.release()
}

func TestCrawlGateGivesUpWithItsContext(t *testing.T) {
	gate := newCrawlGate(1)
	if err := gate.acquire(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := gate.acquire(ctx); err == nil {
		t.Error("acquire on a full gate returned nil, want the context error")
	}
}
