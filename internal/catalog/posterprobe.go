package catalog

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// posterMissing reports whether a poster address cannot be shown. A 404
// or an empty address is missing. A host that does not answer is not:
// Amazon being briefly unreachable should not empty the cold screen.
//
// Tests replace it so a fixture never asks the network.
var posterMissing = rememberPosterMissing

// posterVerdict remembers a definite answer. The cold screen is asked
// on every arrival, and the same addresses come up again and again.
var posterVerdict sync.Map

var posterHTTP = &http.Client{Timeout: 2 * time.Second}

func rememberPosterMissing(ctx context.Context, raw string) bool {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return true
	}
	if v, ok := posterVerdict.Load(raw); ok {
		return v.(bool)
	}
	missing, known := askPoster(ctx, raw)
	if known {
		posterVerdict.Store(raw, missing)
	}
	return missing
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
