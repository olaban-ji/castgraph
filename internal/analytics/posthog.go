// Package analytics owns the process-wide PostHog client.
package analytics

import (
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"os"

	"github.com/posthog/posthog-go"
)

var client posthog.Client

// Init configures the single PostHog client for this process. Production
// processes without configuration continue without analytics; debug processes
// fail clearly instead, so missing events are noticed during development.
// Loopback development (Neo4j on localhost) never creates a client, so product
// events and exception captures stay off the wire.
func Init(logger *slog.Logger) error {
	projectToken := os.Getenv("POSTHOG_PROJECT_TOKEN")
	if projectToken == "" {
		return missingConfig("POSTHOG_PROJECT_TOKEN", logger)
	}

	host := os.Getenv("POSTHOG_HOST")
	if host == "" {
		return missingConfig("POSTHOG_HOST", logger)
	}

	if localDev() {
		return nil
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
	return slog.New(newSlogHandler(logger.Handler(), distinctID))
}

// Close flushes queued events during graceful process shutdown.
func Close() error {
	if client == nil {
		return nil
	}
	return client.Close()
}

// LoopbackHost reports whether host (with or without a port) is loopback.
func LoopbackHost(host string) bool {
	hostname, _, err := net.SplitHostPort(host)
	if err != nil {
		hostname = host
	}
	switch hostname {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	return false
}

func localDev() bool {
	raw := os.Getenv("NEO4J_URI")
	if raw == "" {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return false
	}
	return LoopbackHost(u.Host)
}

func missingConfig(key string, logger *slog.Logger) error {
	message := fmt.Sprintf("%s variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once %s is configured", key, key)
	if os.Getenv("LOG_LEVEL") == "debug" {
		return fmt.Errorf("%s", message)
	}
	logger.Warn(message)
	return nil
}
