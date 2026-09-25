package catalog

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// posterGone reports whether a poster address can be shown, and
// whether the host said so definitively.
//
// `missing` is "do not draw this": a 404, or an empty address. `gone`
// is narrower — the host answered, and the picture it once served is
// not there any more. Only that is worth writing down and asking
// another service about; a host that does not answer is neither, so
// Amazon being briefly unreachable never empties the cold screen and
// never puts a live poster into the repair queue.
//
// Tests replace it so a fixture never asks the network.
var posterGone = rememberPosterGone

// posterVerdict remembers a definite answer. The cold screen is asked
// on every arrival, and the same addresses come up again and again.
var posterVerdict sync.Map

var posterHTTP = &http.Client{Timeout: 2 * time.Second}

// rememberPosterMissing is the plain question, for callers that only
// need to know whether to draw the thing.
func rememberPosterMissing(ctx context.Context, raw string) bool {
	missing, _ := posterGone(ctx, raw)
	return missing
}

// rememberPosterGone asks the host once per address and remembers a
// definite answer. The cold screen is asked on every arrival and the
// same addresses come up again and again.
//
// An empty address is missing but not gone: there is nothing to have
// stopped answering.
func rememberPosterGone(ctx context.Context, raw string) (missing, gone bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return true, false
	}
	if v, ok := posterVerdict.Load(raw); ok {
		return v.(bool), v.(bool)
	}
	dead, known := askPoster(ctx, raw)
	if known {
		posterVerdict.Store(raw, dead)
	}
	return dead, known && dead
}

// askPoster asks the image host. known is false when the answer was not
// a real yes or no — a timeout, a 403, a 500 — so the caller can try
// again later instead of remembering a guess.
func askPoster(ctx context.Context, raw string) (missing, known bool) {
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, raw, nil)
	if err != nil {
		return true, true
	}
	req.Header.Set("User-Agent", "cinedikt")
	resp, err := posterHTTP.Do(req)
	if err != nil {
		return false, false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 512))
	switch resp.StatusCode {
	case http.StatusNotFound, http.StatusGone:
		return true, true
	case http.StatusOK, http.StatusNoContent, http.StatusPartialContent:
		return false, true
	default:
		return false, false
	}
}
