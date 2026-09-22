package config

import "testing"

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
