package api

import "testing"

func TestValidTConst(t *testing.T) {
	for _, c := range []struct {
		id   string
		want bool
	}{
		{"tt0133093", true},
		{"tt0000001", true},
		{"tt12345678901", true}, // ids have grown over the years
		{"tt", false},
		{"", false},
		{"nm0000206", false}, // a person is not a title
		{"603", false},       // the old TMDb id
		{"tt00x1", false},
		{"tt0133093; DROP TABLE titles", false},
		{"TT0133093", false},
		{"tt" + "1234567890123456789012", false},
	} {
		if got := validTConst(c.id); got != c.want {
			t.Errorf("validTConst(%q) = %v, want %v", c.id, got, c.want)
		}
	}
}
