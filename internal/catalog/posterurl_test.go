package catalog

import "testing"

func TestPosterAtAsksEachHostInItsOwnWay(t *testing.T) {
	for _, c := range []struct {
		name, in string
		width    int
		want     string
	}{
		{
			"amazon takes a directive",
			"https://m.media-amazon.com/images/M/abc.jpg", 185,
			"https://m.media-amazon.com/images/M/abc._SX185_.jpg",
		},
		{
			"an existing directive is replaced, not added to",
			"https://m.media-amazon.com/images/M/abc._V1_SX300.jpg", 780,
			"https://m.media-amazon.com/images/M/abc._SX780_.jpg",
		},
		{
			"tmdb names the width in the path",
			"https://image.tmdb.org/t/p/w780/abc.jpg", 185,
			"https://image.tmdb.org/t/p/w185/abc.jpg",
		},
		{
			// TMDb serves a fixed ladder, so a size it does not have is
			// rounded up rather than requested and 404'd.
			"a width tmdb does not serve rounds up",
			"https://image.tmdb.org/t/p/w92/abc.jpg", 200,
			"https://image.tmdb.org/t/p/w342/abc.jpg",
		},
		{
			"past the widest tmdb has, it takes the widest",
			"https://image.tmdb.org/t/p/w92/abc.jpg", 4000,
			"https://image.tmdb.org/t/p/w780/abc.jpg",
		},
		{
			"a host it does not know is left alone",
			"https://example.com/p.jpg", 185,
			"https://example.com/p.jpg",
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := PosterAt(c.in, c.width); got != c.want {
				t.Errorf("PosterAt(%q, %d) = %q, want %q", c.in, c.width, got, c.want)
			}
		})
	}
}
