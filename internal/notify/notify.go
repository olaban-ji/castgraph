// Package notify is the small event a catalog job can raise when
// something about it is worth telling a person. It has no transport of
// its own: a process with nowhere to send an event uses a nil Sink, and
// the jobs do not change what they do.
package notify

// Kind is what happened, which is also what a transport uses to decide
// whether a phone should buzz. Working is progress inside a job that
// has already announced itself; everything else is a change of state.
type Kind string

const (
	Started   Kind = "started"
	Published Kind = "published"
	Failed    Kind = "failed"
	Stale     Kind = "stale"
	Working   Kind = "working"
	CaughtUp  Kind = "caught_up"
	Paused    Kind = "paused"
)

// The jobs the catalog runs. The names are stable so a transport can
// lay their lines out in the same order every time.
const (
	JobImport      = "import"
	JobPosters     = "posters"
	JobTMDbPosters = "tmdb-posters"
	JobTMDbIDs     = "tmdb-ids"
	JobColours     = "colours"
)

// Event is one thing a job wants said. Text is a single short line;
// a transport that needs a paragraph builds it from several events.
type Event struct {
	Job  string
	Kind Kind
	Text string
}

// Pushes reports whether this kind is a change of state. Progress
// inside a job that is already running is not: a phone told about
// every tick would be told about nothing.
func Pushes(k Kind) bool {
	switch k {
	case Started, Published, Failed, Stale, CaughtUp, Paused:
		return true
	default:
		return false
	}
}

// Sink receives events. Note must return quickly and must not fail the
// caller: a job's work does not depend on anyone hearing about it.
type Sink interface {
	Note(Event)
}
