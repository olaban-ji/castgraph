package graph

import (
	"fmt"
	"strconv"
	"strings"
)

// Node kinds as they appear in API payloads and node ids.
const (
	KindMovie  = "movie"
	KindPerson = "person"
)

// Movie is what the crawler knows about a movie when it writes it.
type Movie struct {
	ID           int
	Title        string
	ReleaseDate  string // YYYY-MM-DD, may be empty for unreleased titles
	PosterPath   string // TMDb image path, e.g. /abc.jpg; see PosterURL
	BackdropPath string // landscape still, for wide tiles; see BackdropURL
	Rating       float64
	VoteCount    int
	IMDbID       string  // only known from the movie endpoint, not filmographies
	IMDbRating   float64 // from OMDb; 0 means unknown and never overwrites a stored value
	IMDbVotes    int
}

// PosterBaseURL is prepended to a TMDb poster path to get a fetchable
// image. w342 is a good size for a graph node; swap for w500 or original.
const PosterBaseURL = "https://image.tmdb.org/t/p/w342"

// PosterURL turns a TMDb poster path into a full URL, or "" if there is none.
func PosterURL(path string) string {
	if path == "" {
		return ""
	}
	return PosterBaseURL + path
}

// BackdropBaseURL is prepended to a TMDb backdrop path. w780 suits a
// landscape card a few hundred pixels wide.
const BackdropBaseURL = "https://image.tmdb.org/t/p/w780"

// BackdropURL turns a TMDb backdrop path into a full URL, or "" if none.
func BackdropURL(path string) string {
	if path == "" {
		return ""
	}
	return BackdropBaseURL + path
}

// Person is what the crawler knows about a person when it writes them.
type Person struct {
	ID         int
	Name       string
	Popularity float64
}

// CastEntry is one person's role in a movie being written.
type CastEntry struct {
	Person    Person
	Character string
	Order     int
}

// JobDirector is stored on DIRECTED relationships and returned as a
// pathway role so the map can tell directors from actors.
const JobDirector = "Director"

// FilmCredit is one movie in a person's filmography being written.
// Acting credits leave Job empty; directing credits set Job to JobDirector.
type FilmCredit struct {
	Movie     Movie
	Character string
	Order     int
	Job       string
}

// Node is a graph node shaped for the frontend. ID is "m:<tmdb id>" for
// movies and "p:<tmdb id>" for people so the two id spaces never collide.
type Node struct {
	ID     string `json:"id"`
	Type   string `json:"type"`
	Label  string `json:"label"`
	TMDBID int    `json:"tmdb_id"`
	// Movie-only fields. Rating is TMDb's 0–10 user score over Votes
	// ratings; IMDbID lets a client link to IMDb.
	Year     int     `json:"year,omitempty"`
	Poster   string  `json:"poster,omitempty"`
	Backdrop string  `json:"backdrop,omitempty"`
	Rating   float64 `json:"rating,omitempty"`
	Votes    int     `json:"votes,omitempty"`
	IMDbID   string  `json:"imdb_id,omitempty"`
	// IMDbRating and IMDbVotes come from OMDb and are present only for
	// movies that have been crawled (not those known just from a filmography).
	IMDbRating float64 `json:"imdb_rating,omitempty"`
	IMDbVotes  int     `json:"imdb_votes,omitempty"`
}

// Edge is an ACTED_IN or DIRECTED relationship from a person node to a movie node.
type Edge struct {
	Source string `json:"source"`
	Target string `json:"target"`
	Role   string `json:"role"`
	Order  int    `json:"order"`
}

// Graph is a node/edge list ready to serialise.
type Graph struct {
	Nodes []Node `json:"nodes"`
	Edges []Edge `json:"edges"`
}

// MovieNodeID formats a movie's frontend node id.
func MovieNodeID(id int) string { return "m:" + strconv.Itoa(id) }

// PersonNodeID formats a person's frontend node id.
func PersonNodeID(id int) string { return "p:" + strconv.Itoa(id) }

// ParseNodeID splits a frontend node id into its kind and TMDb id.
func ParseNodeID(s string) (kind string, id int, err error) {
	prefix, num, ok := strings.Cut(s, ":")
	if !ok {
		return "", 0, fmt.Errorf("graph: node id %q: want m:<id> or p:<id>", s)
	}
	id, err = strconv.Atoi(num)
	if err != nil || id <= 0 {
		return "", 0, fmt.Errorf("graph: node id %q: bad numeric part", s)
	}
	switch prefix {
	case "m":
		return KindMovie, id, nil
	case "p":
		return KindPerson, id, nil
	default:
		return "", 0, fmt.Errorf("graph: node id %q: unknown prefix %q", s, prefix)
	}
}

// YearOf extracts the year from a YYYY-MM-DD date, or 0 if there is none.
func YearOf(releaseDate string) int {
	if len(releaseDate) < 4 {
		return 0
	}
	y, err := strconv.Atoi(releaseDate[:4])
	if err != nil {
		return 0
	}
	return y
}
