package catalog

import "cinedikt/internal/notify"

// report hands an event to the sink, if there is one. A nil sink is the
// ordinary case: nothing is configured, and the jobs carry on.
func report(sink notify.Sink, job string, kind notify.Kind, text string) {
	if sink == nil {
		return
	}
	sink.Note(notify.Event{Job: job, Kind: kind, Text: text})
}

// pass is one run of a background job, as far as the notifier is
// concerned.
//
// A wake that finds an empty queue is the common case — the posters
// rest for twenty minutes and then look again — and that must not
// become a message. start is called only once there is a batch to do,
// and finish says nothing unless start did.
type pass struct {
	sink notify.Sink
	job  string
	on   bool
}

func (p *pass) start(text string) {
	if p.on || p.sink == nil {
		return
	}
	p.on = true
	p.sink.Note(notify.Event{Job: p.job, Kind: notify.Started, Text: text})
}

func (p *pass) finish(kind notify.Kind, text string) {
	if !p.on || p.sink == nil {
		return
	}
	p.on = false
	p.sink.Note(notify.Event{Job: p.job, Kind: kind, Text: text})
}
