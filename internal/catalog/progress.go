package catalog

import (
	"fmt"
	"io"
	"log/slog"
	"sync/atomic"
	"time"
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
}

func newProgress(logger *slog.Logger, what string, total int64) *progress {
	now := time.Now()
	return &progress{logger: logger, what: what, start: now, last: now, total: total}
}

// step reports `done` so far, unless it reported recently.
func (p *progress) step(done int64) {
	if time.Since(p.last) < ProgressEvery {
		return
	}
	p.last = time.Now()
	p.logger.Info(p.what, p.fields(done)...)
}

// done reports the final figure, whenever it lands.
func (p *progress) done(done int64) {
	p.logger.Info(p.what+" done", p.fields(done)...)
}

func (p *progress) fields(done int64) []any {
	elapsed := time.Since(p.start)
	out := []any{"elapsed", elapsed.Round(time.Second)}
	if p.total > 0 {
		share := float64(done) / float64(p.total)
		out = append(out, "progress", fmt.Sprintf("%.0f%%", share*100))
		// Only worth guessing once there is enough behind it to guess from.
		if share > 0.02 && share < 1 {
			left := time.Duration(float64(elapsed) * (1 - share) / share)
			out = append(out, "left", left.Round(time.Second))
		}
	}
	// Bytes are read in megabytes and so is their rate; rows are rows.
	bytes := p.total > 1<<20
	secs := elapsed.Seconds()
	if bytes {
		out = append(out, "read", mib(done)+" of "+mib(p.total))
		if secs > 0 {
			out = append(out, "rate", fmt.Sprintf("%.1fMB/s", float64(done)/(1<<20)/secs))
		}
		return out
	}
	out = append(out, "rows", done)
	if secs > 0 {
		out = append(out, "rate", fmt.Sprintf("%.0f rows/s", float64(done)/secs))
	}
	return out
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
