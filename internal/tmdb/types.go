package tmdb

// Movie is a TMDb movie. Credits is populated only when the movie was
// fetched with its credits appended.
type Movie struct {
	ID           int      `json:"id"`
	Title        string   `json:"title"`
	ReleaseDate  string   `json:"release_date"`
	PosterPath   string   `json:"poster_path"`
	BackdropPath string   `json:"backdrop_path"`
	Popularity   float64  `json:"popularity"`
	VoteAverage  float64  `json:"vote_average"`
	VoteCount    int      `json:"vote_count"`
	IMDbID       string   `json:"imdb_id"`
	Credits      *Credits `json:"credits,omitempty"`
}

// Credits is the cast list of a movie.
type Credits struct {
	Cast []CastMember `json:"cast"`
}

// CastMember is one entry of a movie's cast list.
type CastMember struct {
	ID                 int     `json:"id"`
	Name               string  `json:"name"`
	Character          string  `json:"character"`
	Order              int     `json:"order"`
	Popularity         float64 `json:"popularity"`
	KnownForDepartment string  `json:"known_for_department"`
}

// Person is a TMDb person. MovieCredits is populated only when the person
// was fetched with their credits appended.
type Person struct {
	ID                 int           `json:"id"`
	Name               string        `json:"name"`
	Popularity         float64       `json:"popularity"`
	KnownForDepartment string        `json:"known_for_department"`
	Birthday           string        `json:"birthday"`
	Deathday           string        `json:"deathday"`
	MovieCredits       *MovieCredits `json:"movie_credits,omitempty"`
}

// MovieCredits is a person's filmography.
type MovieCredits struct {
	ID   int           `json:"id"`
	Cast []MovieCredit `json:"cast"`
}

// MovieCredit is one movie in a person's filmography.
type MovieCredit struct {
	ID           int     `json:"id"`
	Title        string  `json:"title"`
	ReleaseDate  string  `json:"release_date"`
	PosterPath   string  `json:"poster_path"`
	BackdropPath string  `json:"backdrop_path"`
	Character    string  `json:"character"`
	Order        int     `json:"order"`
	Popularity   float64 `json:"popularity"`
	VoteAverage  float64 `json:"vote_average"`
	VoteCount    int     `json:"vote_count"`
}

// SearchResults is one page of movie search results.
type SearchResults struct {
	Page         int     `json:"page"`
	Results      []Movie `json:"results"`
	TotalResults int     `json:"total_results"`
}
