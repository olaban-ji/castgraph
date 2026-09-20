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
	t.Setenv("NEO4J_URI", "")

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
	t.Setenv("NEO4J_URI", "")

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := Init(logger); err == nil {
		t.Fatal("Init() = nil, want error when LOG_LEVEL=debug")
	}
}

func TestInitLoopbackDoesNotCreateClient(t *testing.T) {
	t.Cleanup(func() { client = nil })
	client = nil
	t.Setenv("POSTHOG_PROJECT_TOKEN", "phc_test")
	t.Setenv("POSTHOG_HOST", "https://us.i.posthog.com")
	t.Setenv("NEO4J_URI", "bolt://localhost:7687")
	t.Setenv("LOG_LEVEL", "")

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := Init(logger); err != nil {
		t.Fatalf("Init() = %v, want nil", err)
	}
	if Client() != nil {
		t.Fatal("Client() != nil, want nil on loopback")
	}
	if got := Logger(logger, "cinedikt-api"); got != logger {
		t.Fatal("Logger() wrapped a loopback client")
	}
}

func TestLoopbackHost(t *testing.T) {
	cases := map[string]bool{
		"localhost":            true,
		"localhost:8080":       true,
		"127.0.0.1":            true,
		"127.0.0.1:5173":       true,
		"[::1]:8080":           true,
		"::1":                  true,
		"cinedikt.example":     false,
		"cinedikt.example:443": false,
	}
	for host, want := range cases {
		if got := LoopbackHost(host); got != want {
			t.Errorf("LoopbackHost(%q) = %v, want %v", host, got, want)
		}
	}
}
