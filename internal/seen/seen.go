// Package seen holds bounded, expiring sets of integer ids: the "have I
// already done this?" memory a long-running crawler needs without the
// unbounded growth of a plain map, and with entries ageing out so the
// graph is eventually refreshed instead of frozen for the life of the
// process.
package seen

import (
	"sync"
	"time"
)

// Set remembers ids for a TTL, evicting the oldest once it reaches Max.
// The zero value is not usable; call New. A Set is safe for concurrent use.
type Set struct {
	max int
	ttl time.Duration
	now func() time.Time

	mu      sync.Mutex
	entries map[int]time.Time // id -> when it was added
}

// DefaultMax is a sensible ceiling for one process's memory of a crawl.
const DefaultMax = 50_000

// New returns a Set holding at most max ids for ttl each. A max below 1
// takes DefaultMax; a ttl below 1 never expires entries (only the size
// cap evicts them).
func New(max int, ttl time.Duration) *Set {
	if max < 1 {
		max = DefaultMax
	}
	return &Set{max: max, ttl: ttl, now: time.Now, entries: make(map[int]time.Time)}
}

// Add records id and reports whether it was new: false means the id was
// already there and still fresh, so the caller can skip the work.
func (s *Set) Add(id int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if at, ok := s.entries[id]; ok && s.fresh(at) {
		return false
	}
	if len(s.entries) >= s.max {
		s.evict()
	}
	s.entries[id] = s.now()
	return true
}

// Has reports whether id is recorded and still fresh.
func (s *Set) Has(id int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	at, ok := s.entries[id]
	return ok && s.fresh(at)
}

// Forget drops id so the next Add sees it as new. Callers use it when the
// work they claimed with Add failed and should be retried.
func (s *Set) Forget(id int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.entries, id)
}

// Len is the number of ids held, including any not yet swept.
func (s *Set) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.entries)
}

func (s *Set) fresh(at time.Time) bool {
	return s.ttl <= 0 || s.now().Sub(at) < s.ttl
}

// evict drops expired entries, then — if that freed nothing — the oldest
// tenth, so a full Set of fresh ids still makes room. Called with the
// lock held.
func (s *Set) evict() {
	before := len(s.entries)
	for id, at := range s.entries {
		if !s.fresh(at) {
			delete(s.entries, id)
		}
	}
	if len(s.entries) < before {
		return
	}
	drop := s.max / 10
	if drop < 1 {
		drop = 1
	}
	for range drop {
		oldest, oldestAt := 0, time.Time{}
		for id, at := range s.entries {
			if oldestAt.IsZero() || at.Before(oldestAt) {
				oldest, oldestAt = id, at
			}
		}
		if oldestAt.IsZero() {
			return
		}
		delete(s.entries, oldest)
	}
}
