package graph

import "testing"

// Cards stacked in one year sit in calendar order, so the spine carries
// the month and day — and nothing else about the date.
func TestMonthDay(t *testing.T) {
	tests := map[string]int{
		"2013-03-20": 320,
		"1999-12-05": 1205,
		"2001-01-01": 101,
		"2001-07":    701,
		"2001":       0,
		"":           0,
		"2001-13-01": 0,
		"2001-02-99": 201,
	}
	for in, want := range tests {
		if got := monthDay(in); got != want {
			t.Errorf("monthDay(%q) = %d, want %d", in, got, want)
		}
	}
}
