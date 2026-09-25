package notify

import "testing"

func TestOnlyAChangeOfStatePushes(t *testing.T) {
	for _, k := range []Kind{Started, Published, Failed, Stale, CaughtUp, Paused} {
		if !Pushes(k) {
			t.Errorf("%s should push", k)
		}
	}
	if Pushes(Working) {
		t.Error("progress inside a running job should not push")
	}
	if Pushes("") {
		t.Error("an unknown kind should not push")
	}
}
