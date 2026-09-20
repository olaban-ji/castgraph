package crawl

import (
	"strings"

	"cinedikt/internal/tmdb"
)

// Scoring decides which cast members are worth crawling further. The depth
// scaling is what keeps fan-out bounded; the absolute numbers track TMDb's
// popularity scale, which TMDb has re-based before, so they are settable.
// Directors of a crawled movie skip this and are always expanded: there is
// one (or two) per film, and the credits payload already names them.
type Scoring struct {
	// ThresholdBase is multiplied by (depth+1) to get the score a cast
	// member needs before their filmography is fetched.
	ThresholdBase float64
	// OrderPenalty is subtracted from popularity per billing position.
	OrderPenalty float64
}

// DefaultScoring is calibrated to TMDb's 2025+ popularity scale, where a
// leading actor scores roughly 3–8, supporting cast 1–3 and extras under 1
// (The Matrix, Sept 2026: Reeves 7.5, Fishburne 2.9, Moss 3.1, Weaving 3.1,
// Pantoliano 2.8, Foster 1.0, everyone else below 0.9). At depth 1 that
// crawls the five leads; depth 2 needs 1.5 and depth 3 needs 2.0.
var DefaultScoring = Scoring{ThresholdBase: 0.5, OrderPenalty: 0.05}

// A filmography entry seeds the next depth level only if the person was
// billed within maxSeedOrder and the movie has at least minSeedVotes.
const (
	maxSeedOrder = 10
	minSeedVotes = 50
)

// threshold is generous at depth 1 (the movie the user asked for) and
// tighter at each further level where fan-out is already large.
func (s Scoring) threshold(depth int) float64 { return s.ThresholdBase * float64(depth+1) }

// ShouldCrawl is phase 1: decide from the credits payload alone, with no
// extra API call, whether a cast member is worth a profile lookup.
func (s Scoring) ShouldCrawl(c tmdb.CastMember, depth int) bool {
	if c.KnownForDepartment != "Acting" {
		return false
	}
	score := c.Popularity - float64(c.Order)*s.OrderPenalty
	return score >= s.threshold(depth)
}

// ShouldExpand is phase 2: the final call, made from the person's own
// profile, on whether to fetch and write their full filmography. The
// profile carries the authoritative department and popularity; the copies
// embedded in a credits list can be stale.
func (s Scoring) ShouldExpand(p tmdb.Person, depth int) bool {
	return p.KnownForDepartment == "Acting" && p.Popularity >= s.threshold(depth)
}

// seedsNextLevel reports whether a filmography entry is worth fetching the
// credits of at the next depth. Bit parts and obscure titles are written to
// the graph but not expanded further.
func seedsNextLevel(c tmdb.MovieCredit) bool {
	return c.Order <= maxSeedOrder && c.VoteCount >= minSeedVotes && c.ReleaseDate != ""
}

// seedsDirected reports whether a directed film is worth fetching at the
// next depth. Crew credits have no billing order, so vote count and a
// release date are the only gates.
func seedsDirected(c tmdb.CrewCredit) bool {
	return c.Job == tmdb.JobDirector && c.VoteCount >= minSeedVotes && c.ReleaseDate != ""
}

// movieDirectors returns the unique Directors from a credits payload.
func movieDirectors(credits *tmdb.Credits) []tmdb.CrewMember {
	if credits == nil {
		return nil
	}
	seen := map[int]bool{}
	var out []tmdb.CrewMember
	for _, c := range credits.Crew {
		if c.Job != tmdb.JobDirector || seen[c.ID] {
			continue
		}
		seen[c.ID] = true
		out = append(out, c)
	}
	return out
}

// isNoiseCredit filters appearances that are not acting connections:
// documentaries where the person appears as themselves, and archive footage.
func isNoiseCredit(character string) bool {
	ch := strings.ToLower(character)
	if strings.HasPrefix(ch, "self") || strings.HasPrefix(ch, "himself") || strings.HasPrefix(ch, "herself") {
		return true
	}
	return strings.Contains(ch, "archive footage")
}
