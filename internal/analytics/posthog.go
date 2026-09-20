// Package analytics owns the process-wide PostHog client.
package analytics

import (
	"context"
	"fmt"
	"log/slog"
	"os"

	"github.com/posthog/posthog-go"
)

var client posthog.Client

// Init configures the single PostHog client for this process. Production
// processes without configuration continue without analytics; debug processes
// fail clearly instead, so missing events are noticed during development.
func Init(logger *slog.Logger) error {
	projectToken := os.Getenv("POSTHOG_PROJECT_TOKEN")
	if projectToken == "" {
		return missingConfig("POSTHOG_PROJECT_TOKEN", logger)
	}

	host := os.Getenv("POSTHOG_HOST")
	if host == "" {
		return missingConfig("POSTHOG_HOST", logger)
	}

	configuredClient, err := posthog.NewWithConfig(projectToken, posthog.Config{
		Endpoint: host,
	})
	if err != nil {
		return fmt.Errorf("configure PostHog client: %w", err)
	}
	client = configuredClient
	return nil
}

// Client returns the process-wide PostHog client, or nil when analytics is not
// configured in a production environment.
func Client() posthog.Client {
	return client
}

// Logger wraps the application logger so warnings and errors are reported to
// PostHog error tracking. The service identifier is stable for this process
// and avoids attaching request or user PII to operational exceptions.
func Logger(logger *slog.Logger, distinctID string) *slog.Logger {
	if client == nil {
		return logger
	}
	return slog.New(posthog.NewSlogCaptureHandler(
		logger.Handler(),
		client,
		posthog.WithDistinctIDFn(func(context.Context, slog.Record) string {
			return distinctID
		}),
	))
}

// Close flushes queued events during graceful process shutdown.
func Close() error {
	if client == nil {
		return nil
	}
	return client.Close()
}

func missingConfig(key string, logger *slog.Logger) error {
	message := fmt.Sprintf("%s variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once %s is configured", key, key)
	if os.Getenv("LOG_LEVEL") == "debug" {
		return fmt.Errorf("%s", message)
	}
	logger.Warn(message)
	return nil
}
