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
	Genres       []Genre  `json:"genres"`
	Credits      *Credits `json:"credits,omitempty"`
}

// Genre is a TMDb genre on a movie payload. A filmography credit carries
// the ids alone, so only the id is ever relied on.
type Genre struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

// GenreDocumentary is TMDb's id for documentary. A person's own filmography
// is full of documentaries *about* film, which are a credit but not a film
// the grid should place beside their work.
const GenreDocumentary = 99

// Credits is the cast and crew of a movie. Crew is present on the same
// append_to_response=credits payload; we only keep Directors from it.
type Credits struct {
	Cast []CastMember `json:"cast"`
	Crew []CrewMember `json:"crew"`
}

// JobDirector is TMDb's crew job for the film's director. Co-directors
// share this job; assistant directors do not.
const JobDirector = "Director"

// CrewMember is one entry of a movie's crew list.
type CrewMember struct {
	ID                 int     `json:"id"`
	Name               string  `json:"name"`
	Job                string  `json:"job"`
	Department         string  `json:"department"`
	Popularity         float64 `json:"popularity"`
	KnownForDepartment string  `json:"known_for_department"`
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

// MovieCredits is a person's filmography, acting and crew.
type MovieCredits struct {
	ID   int           `json:"id"`
	Cast []MovieCredit `json:"cast"`
	Crew []CrewCredit  `json:"crew"`
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
	GenreIDs     []int   `json:"genre_ids"`
}

// CrewCredit is one movie a person worked on in a crew role.
type CrewCredit struct {
	ID           int     `json:"id"`
	Title        string  `json:"title"`
	ReleaseDate  string  `json:"release_date"`
	PosterPath   string  `json:"poster_path"`
	BackdropPath string  `json:"backdrop_path"`
	Job          string  `json:"job"`
	Department   string  `json:"department"`
	Popularity   float64 `json:"popularity"`
	VoteAverage  float64 `json:"vote_average"`
	VoteCount    int     `json:"vote_count"`
	GenreIDs     []int   `json:"genre_ids"`
}

// SearchResults is one page of movie search results.
type SearchResults struct {
	Page         int     `json:"page"`
	Results      []Movie `json:"results"`
	TotalResults int     `json:"total_results"`
}
