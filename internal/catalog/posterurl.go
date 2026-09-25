package catalog

// Asking an image host for the size that is actually going to be drawn.
//
// Both hosts the catalog stores addresses for will resize on request,
// and both say so in the URL — Amazon in a directive before the
// extension, TMDb in a path segment. Fetching a 780px sheet to average
// it into one pixel, or to draw it at 104, is the same waste either way.

import (
	"fmt"
	"strings"
)

// tmdbRungs are the widths TMDb serves. Anything else is rounded up to
// one of these, because a size it does not have is a 404.
var tmdbRungs = []int{92, 154, 185, 342, 500, 780}

const (
	amazonHost = "https://m.media-amazon.com/images/"
	tmdbHost   = "https://image.tmdb.org/t/p/"
)

// PosterAt is a poster's address at a given width. An address on a host
// this does not recognise is returned as it stands: an unfamiliar URL
// still works, it is just not resized.
func PosterAt(url string, width int) string {
	if width < 1 {
		return url
	}
	if rest, ok := strings.CutPrefix(url, tmdbHost); ok {
		_, path, found := strings.Cut(rest, "/")
		if !found {
			return url
		}
		return fmt.Sprintf("%sw%d/%s", tmdbHost, tmdbRung(width), path)
	}
	if !strings.HasPrefix(url, amazonHost) {
		return url
	}
	for _, ext := range []string{".jpg", ".png"} {
		base, ok := strings.CutSuffix(url, ext)
		if !ok {
			continue
		}
		// Whatever directives are already on it are replaced, not added
		// to: two conflicting sizes is not a bigger request, it is a
		// broken one.
		if i := strings.LastIndexByte(base, '.'); i > len(amazonHost) {
			base = base[:i]
		}
		return fmt.Sprintf("%s._SX%d_%s", base, width, ext)
	}
	return url
}

// tmdbRung is the smallest width TMDb serves that is at least as wide
// as the one asked for.
func tmdbRung(width int) int {
	for _, w := range tmdbRungs {
		if w >= width {
			return w
		}
	}
	return tmdbRungs[len(tmdbRungs)-1]
}
