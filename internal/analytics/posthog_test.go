package analytics

import (
	"io"
	"log/slog"
	"testing"
)

func TestInitWithoutConfigIsNoop(t *testing.T) {
	t.Cleanup(func() { client = nil })
	client = nil
	t.Setenv("POSTHOG_PROJECT_TOKEN", "")
	t.Setenv("POSTHOG_HOST", "")
	t.Setenv("LOG_LEVEL", "")

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := Init(logger); err != nil {
		t.Fatalf("Init() = %v, want nil", err)
	}
	if Client() != nil {
		t.Fatal("Client() != nil, want nil")
	}
	if got := Logger(logger, "cinedikt-api"); got != logger {
		t.Fatal("Logger() wrapped an unconfigured client")
	}
	if err := Close(); err != nil {
		t.Fatalf("Close() = %v, want nil", err)
	}
}

func TestInitDebugWithoutConfigErrors(t *testing.T) {
	t.Cleanup(func() { client = nil })
	client = nil
	t.Setenv("POSTHOG_PROJECT_TOKEN", "")
	t.Setenv("LOG_LEVEL", "debug")

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := Init(logger); err == nil {
		t.Fatal("Init() = nil, want error when LOG_LEVEL=debug")
	}
}
