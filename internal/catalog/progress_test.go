package catalog

import (
	"regexp"
	"strconv"
	"testing"
	"time"
)

func TestProgressSaysHowFarAndHowLong(t *testing.T) {
	p := &progress{
		start: time.Now().Add(-(16*time.Minute + 35*time.Second)),
		total: 1_000_000,
	}
	got := fieldMap(p.fields(409632))

	if !regexp.MustCompile(`^\d+m\d+s$`).MatchString(got["elapsed"]) {
		t.Errorf("elapsed = %q, want a duration like 16m35s", got["elapsed"])
	}
	if got["progress"] != "41%" {
		t.Errorf("progress = %q, want 41%%", got["progress"])
	}
	if _, ok := got["rows"]; ok {
		t.Errorf("rows = %q, want the percentage instead", got["rows"])
	}
}

func TestProgressLineIsWhatABoardShows(t *testing.T) {
	p := &progress{
		what:  "filling in posters",
		start: time.Now().Add(-(16*time.Minute + 35*time.Second)),
		total: 1_000_000,
	}
	got := p.line(409632)
	if !regexp.MustCompile(`^filling in posters · 41% · \d+m\d+s left$`).MatchString(got) {
		t.Errorf("line = %q, want the phase, the percentage and how long is left", got)
	}

	open := &progress{what: "loading movies", start: time.Now().Add(-2 * time.Second)}
	if got := open.line(10); !regexp.MustCompile(`^loading movies · 10 rows · \d+s$`).MatchString(got) {
		t.Errorf("line = %q, want the row count when the total is unknown", got)
	}
}

func TestProgressWithoutATotalKeepsTheRowCount(t *testing.T) {
	p := &progress{start: time.Now().Add(-2 * time.Second)}
	got := fieldMap(p.fields(10))
	if got["rows"] != "10" {
		t.Errorf("rows = %q, want 10", got["rows"])
	}
	if _, ok := got["progress"]; ok {
		t.Errorf("progress = %q, want none without a total", got["progress"])
	}
	if !regexp.MustCompile(`^\d+s$`).MatchString(got["elapsed"]) {
		t.Errorf("elapsed = %q, want a duration like 2s", got["elapsed"])
	}
}

func fieldMap(fields []any) map[string]string {
	out := make(map[string]string, len(fields)/2)
	for i := 0; i+1 < len(fields); i += 2 {
		key, _ := fields[i].(string)
		switch v := fields[i+1].(type) {
		case string:
			out[key] = v
		case int64:
			out[key] = strconv.FormatInt(v, 10)
		}
	}
	return out
}
