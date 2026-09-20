package analytics

import (
	"context"
	"log/slog"

	"github.com/posthog/posthog-go"
)

func newSlogHandler(next slog.Handler, distinctID string) slog.Handler {
	return posthog.NewSlogCaptureHandler(
		next,
		client,
		posthog.WithDistinctIDFn(func(_ context.Context, _ slog.Record) string {
			return distinctID
		}),
	)
}
