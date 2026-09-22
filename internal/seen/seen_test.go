package seen

import (
	"sync"
	"testing"
	"time"
)

func TestAddReportsNewIds(t *testing.T) {
	s := New(10, time.Hour)
	if !s.Add(1) {
		t.Error("first Add(1) = false, want true")
	}
	if s.Add(1) {
		t.Error("second Add(1) = true, want false")
	}
	if !s.Has(1) || s.Has(2) {
		t.Errorf("Has(1)=%v Has(2)=%v", s.Has(1), s.Has(2))
	}
}

func TestForgetAllowsRetry(t *testing.T) {
	s := New(10, time.Hour)
	s.Add(1)
	s.Forget(1)
	if !s.Add(1) {
		t.Error("Add after Forget = false, want true")
	}
}

func TestEntriesExpire(t *testing.T) {
	now := time.Now()
	s := New(10, time.Minute)
	s.now = func() time.Time { return now }
	s.Add(1)
	now = now.Add(2 * time.Minute)
	if s.Has(1) {
		t.Error("expired id still present")
	}
	if !s.Add(1) {
		t.Error("Add of an expired id = false, want true")
	}
}

func TestSizeCapEvictsOldestFirst(t *testing.T) {
	now := time.Now()
	s := New(10, time.Hour)
	s.now = func() time.Time { return now }
	for i := range 10 {
		s.Add(i)
		now = now.Add(time.Second)
	}
	s.Add(100) // over the cap: the oldest tenth goes
	if s.Len() > 10 {
		t.Errorf("Len = %d, want <= 10", s.Len())
	}
	if s.Has(0) {
		t.Error("oldest id survived eviction")
	}
	if !s.Has(9) || !s.Has(100) {
		t.Error("newest ids were evicted")
	}
}

func TestExpiredEntriesAreSweptBeforeOldestAreDropped(t *testing.T) {
	now := time.Now()
	s := New(4, time.Minute)
	s.now = func() time.Time { return now }
	s.Add(1)
	s.Add(2)
	now = now.Add(2 * time.Minute) // 1 and 2 expire
	s.Add(3)
	s.Add(4)
	s.Add(5) // hits the cap; the sweep frees the two expired ids
	for _, id := range []int{3, 4, 5} {
		if !s.Has(id) {
			t.Errorf("fresh id %d was evicted while expired ids could have been", id)
		}
	}
}

func TestConcurrentUse(t *testing.T) {
	s := New(100, time.Hour)
	var wg sync.WaitGroup
	var mu sync.Mutex
	added := 0
	for i := range 50 {
		wg.Add(2)
		for range 2 {
			go func() {
				defer wg.Done()
				if s.Add(i) {
					mu.Lock()
					added++
					mu.Unlock()
				}
			}()
		}
	}
	wg.Wait()
	if added != 50 {
		t.Errorf("Add returned true %d times, want 50: every id must be claimed once", added)
	}
}
