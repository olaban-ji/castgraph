package crawl

import (
	"testing"

	"castgraph/internal/tmdb"
)

func TestShouldCrawl(t *testing.T) {
	tests := []struct {
		name  string
		cast  tmdb.CastMember
		depth int
		want  bool
	}{
		{"lead at depth 1", tmdb.CastMember{Order: 0, Popularity: 7.5, KnownForDepartment: "Acting"}, 1, true},
		{"supporting at depth 1", tmdb.CastMember{Order: 5, Popularity: 2.8, KnownForDepartment: "Acting"}, 1, true},
		{"just over threshold", tmdb.CastMember{Order: 0, Popularity: 1.0, KnownForDepartment: "Acting"}, 1, true},
		{"just under threshold", tmdb.CastMember{Order: 0, Popularity: 0.99, KnownForDepartment: "Acting"}, 1, false},
		{"billing order penalises", tmdb.CastMember{Order: 4, Popularity: 1.1, KnownForDepartment: "Acting"}, 1, false},
		{"stricter at depth 2", tmdb.CastMember{Order: 0, Popularity: 1.2, KnownForDepartment: "Acting"}, 2, false},
		{"crew with acting credit", tmdb.CastMember{Order: 0, Popularity: 90, KnownForDepartment: "Directing"}, 1, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := DefaultScoring.ShouldCrawl(tt.cast, tt.depth); got != tt.want {
				t.Errorf("ShouldCrawl(%+v, %d) = %v, want %v", tt.cast, tt.depth, got, tt.want)
			}
		})
	}
}

func TestShouldExpand(t *testing.T) {
	tests := []struct {
		name   string
		person tmdb.Person
		depth  int
		want   bool
	}{
		{"popular actor", tmdb.Person{Popularity: 3, KnownForDepartment: "Acting"}, 1, true},
		{"unpopular actor", tmdb.Person{Popularity: 0.7, KnownForDepartment: "Acting"}, 1, false},
		{"popular non-actor", tmdb.Person{Popularity: 9, KnownForDepartment: "Production"}, 1, false},
		{"depth raises the bar", tmdb.Person{Popularity: 1.8, KnownForDepartment: "Acting"}, 3, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := DefaultScoring.ShouldExpand(tt.person, tt.depth); got != tt.want {
				t.Errorf("ShouldExpand(%+v, %d) = %v, want %v", tt.person, tt.depth, got, tt.want)
			}
		})
	}
}

func TestIsNoiseCredit(t *testing.T) {
	tests := []struct {
		character string
		want      bool
	}{
		{"Neo", false},
		{"Self", true},
		{"Self - Narrator", true},
		{"Himself", true},
		{"Herself (archive footage)", true},
		{"Agent Smith (archive footage)", true},
		{"Trinity (voice)", false},
		{"", false},
	}
	for _, tt := range tests {
		if got := isNoiseCredit(tt.character); got != tt.want {
			t.Errorf("isNoiseCredit(%q) = %v, want %v", tt.character, got, tt.want)
		}
	}
}

func TestSeedsNextLevel(t *testing.T) {
	tests := []struct {
		name   string
		credit tmdb.MovieCredit
		want   bool
	}{
		{"lead in a known film", tmdb.MovieCredit{Order: 0, VoteCount: 500, ReleaseDate: "1999-03-31"}, true},
		{"bit part", tmdb.MovieCredit{Order: 30, VoteCount: 500, ReleaseDate: "1999-03-31"}, false},
		{"obscure title", tmdb.MovieCredit{Order: 0, VoteCount: 3, ReleaseDate: "1999-03-31"}, false},
		{"unreleased", tmdb.MovieCredit{Order: 0, VoteCount: 500}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := seedsNextLevel(tt.credit); got != tt.want {
				t.Errorf("seedsNextLevel(%+v) = %v, want %v", tt.credit, got, tt.want)
			}
		})
	}
}
