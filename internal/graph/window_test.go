package graph

import "testing"

func TestCenterWindowBorrowsFromTheSideThatHasFilms(t *testing.T) {
	before, after, moreBefore, moreAfter := centerWindow(10, 10, 5)
	if before != 2 || after != 2 || !moreBefore || !moreAfter {
		t.Fatalf("center = %d %d %v %v", before, after, moreBefore, moreAfter)
	}
	// Nothing newer: the screen fills with earlier films.
	before, after, moreBefore, moreAfter = centerWindow(10, 0, 5)
	if before != 4 || after != 0 || !moreBefore || moreAfter {
		t.Fatalf("end = %d %d %v %v", before, after, moreBefore, moreAfter)
	}
	before, after, moreBefore, moreAfter = centerWindow(1, 10, 5)
	if before != 1 || after != 3 || moreBefore || !moreAfter {
		t.Fatalf("short side = %d %d %v %v", before, after, moreBefore, moreAfter)
	}
	before, after, moreBefore, moreAfter = centerWindow(0, 0, 5)
	if before != 0 || after != 0 || moreBefore || moreAfter {
		t.Fatalf("alone = %d %d %v %v", before, after, moreBefore, moreAfter)
	}
}

func TestPageWindowKeepsOneScreen(t *testing.T) {
	keep, more := pageWindow(6, 5)
	if keep != 5 || !more {
		t.Fatalf("long = %d %v", keep, more)
	}
	keep, more = pageWindow(2, 5)
	if keep != 2 || more {
		t.Fatalf("short = %d %v", keep, more)
	}
}
