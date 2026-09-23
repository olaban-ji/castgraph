package config

import (
	"context"
	"log/slog"
	"testing"
)

func TestListenAddr(t *testing.T) {
	t.Setenv("API_ADDR", "")
	t.Setenv("PORT", "")
	if got := listenAddr(); got != ":8080" {
		t.Fatalf("listenAddr() = %q, want :8080", got)
	}

	t.Setenv("PORT", "9090")
	if got := listenAddr(); got != ":9090" {
		t.Fatalf("PORT=9090 listenAddr() = %q, want :9090", got)
	}

	t.Setenv("PORT", ":7070")
	if got := listenAddr(); got != ":7070" {
		t.Fatalf("PORT=:7070 listenAddr() = %q, want :7070", got)
	}

	t.Setenv("API_ADDR", ":6060")
	t.Setenv("PORT", "9090")
	if got := listenAddr(); got != ":6060" {
		t.Fatalf("API_ADDR wins: listenAddr() = %q, want :6060", got)
	}
}

func TestEnvironment(t *testing.T) {
	cases := map[string]struct {
		want    string
		wantErr bool
	}{
		"":            {EnvDevelopment, false},
		"development": {EnvDevelopment, false},
		"dev":         {EnvDevelopment, false},
		"production":  {EnvProduction, false},
		"PRODUCTION":  {EnvProduction, false},
		"prod":        {EnvProduction, false},
		" prod ":      {EnvProduction, false},
		"staging":     {"", true},
		"prodction":   {"", true},
	}
	for value, tc := range cases {
		t.Run(value, func(t *testing.T) {
			t.Setenv("APP_ENV", value)
			got, err := environment()
			if tc.wantErr {
				if err == nil {
					t.Fatalf("APP_ENV=%q: error = nil; a misspelt environment must not silently downgrade", value)
				}
				return
			}
			if err != nil {
				t.Fatalf("APP_ENV=%q: %v", value, err)
			}
			if got != tc.want {
				t.Errorf("APP_ENV=%q gave %q, want %q", value, got, tc.want)
			}
		})
	}
}

func TestProduction(t *testing.T) {
	if (Config{Environment: EnvProduction}).Production() != true {
		t.Error("production config does not report Production()")
	}
	if (Config{Environment: EnvDevelopment}).Production() != false {
		t.Error("development config reports Production()")
	}
}

func TestNewLoggerFormatsForTheEnvironment(t *testing.T) {
	t.Run("production writes single-line JSON a collector can read", func(t *testing.T) {
		t.Setenv("APP_ENV", "production")
		h := NewLogger(slog.LevelInfo).Handler()
		if _, ok := h.(*slog.JSONHandler); !ok {
			t.Errorf("handler = %T, want *slog.JSONHandler", h)
		}
	})
	t.Run("development stays readable text", func(t *testing.T) {
		t.Setenv("APP_ENV", "development")
		h := NewLogger(slog.LevelInfo).Handler()
		if _, ok := h.(*slog.TextHandler); !ok {
			t.Errorf("handler = %T, want *slog.TextHandler", h)
		}
	})
	t.Run("an unset or unreadable APP_ENV is not production", func(t *testing.T) {
		t.Setenv("APP_ENV", "")
		if _, ok := NewLogger(slog.LevelInfo).Handler().(*slog.TextHandler); !ok {
			t.Error("unset APP_ENV should log as development")
		}
		t.Setenv("APP_ENV", "nonsense")
		if _, ok := NewLogger(slog.LevelInfo).Handler().(*slog.TextHandler); !ok {
			t.Error("an unreadable APP_ENV should log as development")
		}
	})
	t.Run("respects the level it is given", func(t *testing.T) {
		t.Setenv("APP_ENV", "production")
		if NewLogger(slog.LevelDebug).Enabled(context.Background(), slog.LevelDebug) != true {
			t.Error("debug logger does not log at debug")
		}
		if NewLogger(slog.LevelInfo).Enabled(context.Background(), slog.LevelDebug) != false {
			t.Error("info logger logs at debug")
		}
	})
}
