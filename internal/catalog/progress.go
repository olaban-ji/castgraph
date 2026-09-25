package catalog

import (
	"fmt"
	"io"
	"log/slog"
	"sync/atomic"
	"time"

	"cinedikt/internal/notify"
)

// ProgressEvery is how often a long step says where it has got to. Often
// enough that the importer never looks wedged, rare enough that an hour
// of logs is still readable.
const ProgressEvery = 5 * time.Second

// progress reports how far a step has got, at most once every
// ProgressEvery. Every long phase of an import owns one: a download of
// three-quarters of a gigabyte and a scan of twelve million rows are
// both minutes of silence otherwise, and silence and a hang look alike.
type progress struct {
	logger *slog.Logger
	what   string
	start  time.Time
	last   time.Time
	// total is what `done` is counted against; 0 when it is not known.
	total int64
	// bytes marks a download, whose total is a length rather than a
	// number of rows. A long row count would otherwise look like one.
	bytes bool
	// hear, if set, is told the same line the log gets. It is how a
	// notifier keeps a status board current without a message per tick.
	// Nil changes nothing, and the log stays the record either way.
	hear func(string)
}

func newProgress(logger *slog.Logger, what string, total int64) *progress {
	now := time.Now()
	return &progress{logger: logger, what: what, start: now, last: now, total: total}
}

// newByteProgress is a download's progress: `total` is a content length.
func newByteProgress(logger *slog.Logger, what string, total int64) *progress {
	p := newProgress(logger, what, total)
	p.bytes = true
	return p
}

// watch sends each logged line to sink as progress, not as a new
// notification. A nil sink leaves the tracker as it was.
func (p *progress) watch(sink notify.Sink, job string) {
	if sink == nil {
		return
	}
	p.hear = func(text string) {
		sink.Note(notify.Event{Job: job, Kind: notify.Working, Text: text})
	}
}

// step reports `done` so far, unless it reported recently.
func (p *progress) step(done int64) {
	if time.Since(p.last) < ProgressEvery {
		return
	}
	p.last = time.Now()
	p.logger.Info(p.what, p.fields(done)...)
	p.heard(done)
}

// done reports the final figure, whenever it lands.
func (p *progress) done(done int64) {
	p.logger.Info(p.what+" done", p.fields(done)...)
	p.heard(done)
}

func (p *progress) heard(done int64) {
	if p.hear != nil {
		p.hear(p.line(done))
	}
}

// line is the progress a chat shows. The log keeps the raw fields;
// this leaves out the phase name, because the message already says
// which job it is, and writes the time left as words.
func (p *progress) line(done int64) string {
	if p.total > 0 {
		share := float64(done) / float64(p.total)
		if share > 1 {
			share = 1
		}
		if share >= 1 {
			return "done"
		}
		pct := fmt.Sprintf("%.0f%% done", share*100)
		if share > 0.02 {
			elapsed := time.Since(p.start)
			left := time.Duration(float64(elapsed) * (1 - share) / share)
			return pct + ", " + rough(left) + " left"
		}
		return pct
	}
	if p.bytes {
		return mib(done) + " downloaded"
	}
	return count(done) + " rows read"
}

// rough is a duration as a person says it. The log keeps the compact
// form from clock; a chat should not say 1h52m10s.
func rough(d time.Duration) string {
	if d < time.Minute {
		return "less than a minute"
	}
	d = d.Round(time.Minute)
	h := int(d / time.Hour)
	m := int((d % time.Hour) / time.Minute)
	switch {
	case h == 0 && m == 1:
		return "1 minute"
	case h == 0:
		return fmt.Sprintf("%d minutes", m)
	case m == 0 && h == 1:
		return "1 hour"
	case m == 0:
		return fmt.Sprintf("%d hours", h)
	case h == 1:
		return fmt.Sprintf("1 hour %d minutes", m)
	default:
		return fmt.Sprintf("%d hours %d minutes", h, m)
	}
}

func (p *progress) fields(done int64) []any {
	elapsed := time.Since(p.start)
	out := []any{"elapsed", clock(elapsed)}
	if p.total > 0 {
		share := float64(done) / float64(p.total)
		if share > 1 {
			share = 1
		}
		out = append(out, "progress", fmt.Sprintf("%.0f%%", share*100))
		// Only worth guessing once there is enough behind it to guess from.
		if share > 0.02 && share < 1 {
			left := time.Duration(float64(elapsed) * (1 - share) / share)
			out = append(out, "left", clock(left))
		}
	}
	// A download is counted in bytes. Everything else is rows, and once
	// the size of the job is known the row count is the percentage above.
	secs := elapsed.Seconds()
	if p.bytes {
		out = append(out, "read", mib(done)+" of "+mib(p.total))
		if secs > 0 {
			out = append(out, "rate", fmt.Sprintf("%.1fMB/s", float64(done)/(1<<20)/secs))
		}
		return out
	}
	if p.total > 0 {
		if secs > 0 {
			out = append(out, "rate", fmt.Sprintf("%.0f rows/s", float64(done)/secs))
		}
		return out
	}
	out = append(out, "rows", done)
	if secs > 0 {
		out = append(out, "rate", fmt.Sprintf("%.0f rows/s", float64(done)/secs))
	}
	return out
}

// clock is a duration a person can read. slog prints a Duration as its
// nanoseconds, which is how "16 minutes" came out as 995000000000.
func clock(d time.Duration) string {
	d = d.Round(time.Second)
	if d < time.Second {
		return "0s"
	}
	return d.String()
}

func mib(n int64) string { return fmt.Sprintf("%.0fMB", float64(n)/(1<<20)) }

// countingReader passes bytes through and counts them, so a download can
// say how far along it is without the caller reading the body twice.
type countingReader struct {
	r    io.Reader
	n    atomic.Int64
	each func(int64)
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	if n > 0 {
		c.each(c.n.Add(int64(n)))
	}
	return n, err
}
