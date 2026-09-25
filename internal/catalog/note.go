package catalog

import (
	"strconv"
	"strings"

	"cinedikt/internal/notify"
)

// count is a number a person can read. 104738 is a log figure;
// 104,738 is a count.
func count(n int64) string {
	sign := ""
	if n < 0 {
		sign = "-"
		n = -n
	}
	s := strconv.FormatInt(n, 10)
	lead := len(s) % 3
	if lead == 0 {
		lead = 3
	}
	var b strings.Builder
	b.WriteString(sign)
	b.WriteString(s[:lead])
	for i := lead; i < len(s); i += 3 {
		b.WriteByte(',')
		b.WriteString(s[i : i+3])
	}
	return b.String()
}

// result is how a finished pass reads: what it saved, and what failed,
// with either half left out when it is zero.
func result(done, failed int64, verb string) string {
	switch {
	case done == 0 && failed == 0:
		return "nothing new"
	case failed == 0:
		return verb + " " + count(done)
	case done == 0:
		return "none " + verb + ", " + count(failed) + " failed"
	default:
		return verb + " " + count(done) + ", " + count(failed) + " failed"
	}
}

// pictureResult is the TMDb poster pass: pictures found, titles that
// have none, and lookups that failed.
func pictureResult(found, none, failed int64) string {
	return parts([]string{
		when(found, "found "+count(found)),
		when(none, count(none)+" had no picture"),
		when(failed, count(failed)+" failed"),
	})
}

// matchResult is the TMDb id pass, in the same shape.
func matchResult(matched, none, failed int64) string {
	return parts([]string{
		when(matched, "matched "+count(matched)),
		when(none, count(none)+" had no match"),
		when(failed, count(failed)+" failed"),
	})
}

func when(n int64, text string) string {
	if n == 0 {
		return ""
	}
	return text
}

func parts(in []string) string {
	var kept []string
	for _, s := range in {
		if s != "" {
			kept = append(kept, s)
		}
	}
	if len(kept) == 0 {
		return "nothing new"
	}
	return strings.Join(kept, ", ")
}

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
