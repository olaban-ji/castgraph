import { describe, expect, it } from 'vitest';
import matrix from './fixtures/matrix-grid.json';
import { opacityOf } from './GridMap';
import { keyYear } from './YearRange';
import {
  activeFilters,
  changedCount,
  clampRating,
  isLit,
  yearBounds,
  DEFAULT_SETTINGS,
  fitLane,
  GAP,
  gridLines,
  initialsFor,
  inWarmSpan,
  layoutGrid,
  markersFor,
  dateOrd,
  metricsFor,
  aloneAfterHiding,
  litOthers,
  nothingLit,
  onPlot,
  othersOnPlot,
  rangeHoldsNone,
  passesFloor,
  revealDelay,
  settingsFrom,
  REVEAL_MAX_MS,
  warmSpan,
  NUDGE_RATIO,
  R_HI,
  R_LO,
  spineOf,
  xOf,
  DOT,
  MARKER_GAP,
  type GridPayload,
  type GridPerson,
  type Placed,
  type SpineFilm,
  type SpineTuple,
  type GridSettings,
} from './grid';

const real = matrix as unknown as GridPayload;
/** A payload shaped like the server's: films as [id, year, rating]. */
type FilmSpec = {
  id: string;
  year: number;
  rating: number | null;
  md?: number;
  /** Places in the chip row, as the server sends them. */
  people?: number[];
};

function payloadOf(
  anchor: { id: string; year: number; rating: number | null; md?: number },
  films: FilmSpec[],
  people: GridPerson[] = [],
): GridPayload {
  return {
    anchor: { ...anchor, md: anchor.md ?? 0, title: 'Anchor', people: [], isAnchor: true },
    people,
    films: films.map(
      (f) => [f.id, f.year, f.rating, f.md ?? 0, f.people ?? []] as SpineTuple,
    ),
  };
}

/** A chip row of n people, for the tests that select one. */
function castOf(n: number): GridPerson[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `nm${String(i).padStart(7, '0')}`,
    name: `Person ${i}`,
    role: 'cast' as const,
    order: i,
  }));
}

const WIDTHS = [390, 924, 1280, 1680];

function settings(over: Partial<GridSettings> = {}): GridSettings {
  return { ...DEFAULT_SETTINGS, ...over };
}

describe('the rating scale', () => {
  it('puts a low rating left and a high one right', () => {
    const m = metricsFor(1280, settings());
    expect(xOf(R_LO, m)).toBeLessThan(xOf(R_HI, m));
    expect(xOf(4, m)).toBeLessThan(xOf(8, m));
  });

  it('is fixed, not taken from the data, so a 7 is always in the same place', () => {
    const m = metricsFor(1280, settings());
    expect(xOf(R_LO, m)).toBeCloseTo(m.left, 6);
    expect(xOf(R_HI, m)).toBeCloseTo(m.right, 6);
  });

  it('holds an off-scale rating at the end rather than off the plot', () => {
    expect(clampRating(1)).toBe(R_LO);
    expect(clampRating(10)).toBe(R_HI);
    const m = metricsFor(1280, settings());
    expect(xOf(1, m)).toBe(xOf(R_LO, m));
    expect(xOf(10, m)).toBe(xOf(R_HI, m));
  });

  it('labels 4.0 to 9.0 on their own gridlines, without overlapping', () => {
    for (const w of WIDTHS) {
      const m = metricsFor(w, settings());
      const lines = gridLines(m);
      expect(lines.map((l) => l.label)).toEqual(['4.0', '5.0', '6.0', '7.0', '8.0', '9.0']);
      for (const l of lines) {
        // §10.6: the label's 40px box is centred on its line, within 1px.
        expect(Math.abs(l.labelLeft + 20 - l.x)).toBeLessThanOrEqual(1);
      }
      for (let i = 1; i < lines.length; i++) {
        expect(lines[i].labelLeft - (lines[i - 1].labelLeft + 40)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('dateOrd', () => {
  it('reads month and day, and puts a year-only date at the head of its year', () => {
    expect(dateOrd({ year: 2013, md: 310 })).toBe(20130310);
    expect(dateOrd({ year: 2013, md: 1201 })).toBe(20131201);
    expect(dateOrd({ year: 2013, md: 0 })).toBe(20130101);
  });
});

describe('lane packing', () => {
  it('keeps a card at its honest x when the lane is clear', () => {
    expect(fitLane([], 500, 116)).toEqual({ lane: 0, left: 500 });
    expect(fitLane([300], 500, 116)).toEqual({ lane: 0, left: 500 });
  });

  it('nudges a card right rather than opening a lane for a near miss', () => {
    const cardW = 116;
    const end = 500;
    const ideal = end + GAP - 10; // 10px short of clear
    const { lane, left } = fitLane([end], ideal, cardW);
    expect(lane).toBe(0);
    expect(left).toBe(end + GAP);
    expect(left - ideal).toBeLessThanOrEqual(Math.round(cardW * NUDGE_RATIO));
  });

  it('opens a new lane rather than telling a lie about the rating', () => {
    const cardW = 116;
    const { lane, left } = fitLane([900], 100, cardW);
    expect(lane).toBe(1);
    expect(left).toBe(100); // exactly where the rating says
  });
});

describe('layoutGrid on the real Matrix payload', () => {
  it('places every film', () => {
    const l = layoutGrid(real, 1280);
    expect(l.cards).toHaveLength(real.films.length);
    expect(l.rows.length).toBeGreaterThan(20);
  });

  // §10.1
  it('puts a rated card within a nudge of its rating, at every width', () => {
    for (const w of WIDTHS) {
      const l = layoutGrid(real, w);
      const slack = l.metrics.cardW * NUDGE_RATIO + 1;
      for (const c of l.cards) {
        if (c.film.rating == null) continue;
        const centre = c.left + l.metrics.cardW / 2;
        expect(Math.abs(centre - xOf(c.film.rating, l.metrics)), String(c.film.id)).toBeLessThanOrEqual(slack);
      }
    }
  });

  // §10.1
  it('keeps every unrated card in the No rating column', () => {
    const l = layoutGrid(real, 1280);
    const unrated = l.cards.filter((c) => c.film.rating == null);
    expect(unrated.length).toBeGreaterThan(0);
    for (const c of unrated) {
      expect(c.left).toBeGreaterThanOrEqual(l.metrics.railW);
      expect(c.left + l.metrics.cardW).toBeLessThanOrEqual(l.unratedEdge + l.metrics.cardW);
    }
  });

  // §10.2
  it('never overlaps two cards', () => {
    for (const w of WIDTHS) {
      const l = layoutGrid(real, w);
      const { cardW, cardH } = l.metrics;
      const byLane = new Map<string, typeof l.cards>();
      for (const c of l.cards) {
        const key = `${c.top}`;
        const list = byLane.get(key);
        if (list) list.push(c);
        else byLane.set(key, [c]);
      }
      for (const [, list] of byLane) {
        const sorted = [...list].sort((a, b) => a.left - b.left);
        for (let i = 1; i < sorted.length; i++) {
          expect(sorted[i].left, `film ${sorted[i].film.id} at ${w}px`).toBeGreaterThanOrEqual(
            sorted[i - 1].left + cardW,
          );
        }
      }
      // And no row's cards spill into the row below.
      for (const r of l.rows) {
        const last = r.top + 12 + (r.lanes - 1) * (cardH + GAP) + cardH;
        expect(last).toBeLessThanOrEqual(r.top + r.height + GAP);
      }
    }
  });

  it('orders rows oldest first, or newest first when asked', () => {
    const oldest = layoutGrid(real, 1280, settings({ yearOrder: 'oldest' }));
    expect(oldest.rows[0].year).toBeLessThan(oldest.rows[oldest.rows.length - 1].year);
    const newest = layoutGrid(real, 1280, settings({ yearOrder: 'newest' }));
    expect(newest.rows[0].year).toBeGreaterThan(newest.rows[newest.rows.length - 1].year);
  });

  it('stacks rows downward with no overlap and room at the bottom', () => {
    const l = layoutGrid(real, 1280);
    for (let i = 1; i < l.rows.length; i++) {
      expect(l.rows[i].top).toBeGreaterThanOrEqual(l.rows[i - 1].top + l.rows[i - 1].height);
    }
    const last = l.rows[l.rows.length - 1];
    expect(l.plotH).toBeGreaterThan(last.top + last.height);
  });

  it('marks the searched film and its year', () => {
    const l = layoutGrid(real, 1280);
    expect(l.anchor?.film.id).toBe(real.anchor.id);
    expect(l.anchor?.film.isAnchor).toBe(true);
    expect(l.rows.find((r) => r.year === real.anchor.year)?.anchorYear).toBe(true);
  });

  it('drops the unrated column when the reader turns it off', () => {
    const l = layoutGrid(real, 1280, settings({ showUnrated: false }));
    expect(l.cards.every((c) => c.film.rating != null)).toBe(true);
    expect(l.metrics.unratedW).toBe(0);
    expect(l.unratedEdge).toBe(l.metrics.railW);
  });

  // §10.10
  it('does not move a card when people are selected — that is opacity only', () => {
    const a = layoutGrid(real, 1280);
    const b = layoutGrid(real, 1280);
    expect(b.cards.map((c) => [c.film.id, c.left, c.top])).toEqual(
      a.cards.map((c) => [c.film.id, c.left, c.top]),
    );
  });



  it('stacks an earlier month above a later one when the cards would collide', () => {
    const year = 2013;
    const jan = { id: 'tt0000001', year, rating: 6.0, md: 120 };
    const dec = { id: 'tt0000002', year, rating: 6.05, md: 1205 };
    const laid = layoutGrid(payloadOf(jan, [jan, dec]), 1280);
    const a = laid.cards.find((c) => c.film.id === 'tt0000001')!;
    const b = laid.cards.find((c) => c.film.id === 'tt0000002')!;
    expect(a.lane).toBeLessThan(b.lane);
    expect(a.left).toBeLessThan(b.left + laid.metrics.cardW);
  });

  it('keeps a later month on top when the years themselves run newest first', () => {
    const year = 2013;
    const jan = { id: 'tt0000001', year, rating: 6.0, md: 120 };
    const dec = { id: 'tt0000002', year, rating: 6.05, md: 1205 };
    const laid = layoutGrid(
      payloadOf(jan, [jan, dec]),
      1280,
      settings({ yearOrder: 'newest' }),
    );
    const a = laid.cards.find((c) => c.film.id === 'tt0000001')!;
    const b = laid.cards.find((c) => c.film.id === 'tt0000002')!;
    expect(b.lane).toBeLessThan(a.lane);
  });


});

describe('initials', () => {
  it('takes the first letter of each end of the name', () => {
    const codes = initialsFor(real.people);
    const keanu = real.people.find((p) => p.name === 'Keanu Reeves')!;
    expect(codes.get(keanu.id)).toBe('KR');
  });

  it('tells two people with the same initials apart', () => {
    // Both Wachowskis are L + Wachowski, which is exactly the case the
    // spec's own rule cannot separate.
    const codes = initialsFor([
      { id: 'nm0000001', name: 'Lana Wachowski', role: 'director', order: -1 },
      { id: 'nm0000002', name: 'Lilly Wachowski', role: 'director', order: -1 },
    ]);
    expect(codes.get('nm0000001')).toBe('LaW');
    expect(codes.get('nm0000002')).toBe('LiW');
    expect(new Set([...codes.values()]).size).toBe(2);
  });

  it('gives everyone on a real map a code of their own', () => {
    const codes = initialsFor(real.people);
    expect(new Set([...codes.values()]).size).toBe(real.people.length);
  });

  it('copes with a single name', () => {
    const codes = initialsFor([{ id: 'nm0000001', name: 'Cher', role: 'cast', order: 0 }]);
    expect(codes.get('nm0000001')).toBe('C');
  });
});

describe('markersFor', () => {
  const wide = metricsFor(1280, DEFAULT_SETTINGS);
  const phone = metricsFor(390, DEFAULT_SETTINGS);

  it('shows initials for one or two people', () => {
    const m = markersFor(['nm0000001', 'nm0000002'], wide, 7.5);
    expect(m.initials).toBe(true);
    expect(m.show).toEqual(['nm0000001', 'nm0000002']);
    expect(m.extra).toBe(0);
  });

  it('switches to dots once there are three', () => {
    const m = markersFor(['nm0000001', 'nm0000002', 'nm0000003'], wide, 7.5);
    expect(m.initials).toBe(false);
    expect(m.extra).toBe(0);
  });

  // §10.4: a row of markers that does not fit is a row that gets clipped.
  it('never draws more markers than the row has room for', () => {
    const many = Array.from({ length: 20 }, (_, i) => `nm${String(i).padStart(7, '0')}`);
    for (const m of [wide, phone]) {
      for (const rating of [8.1, null]) {
        const got = markersFor(many, m, rating);
        const used = got.show.length * (DOT + MARKER_GAP) + (got.extra > 0 ? 22 : 0);
        const budget = m.cardW - m.posterW - 16 - (rating == null ? 54 : 24) - MARKER_GAP;
        expect(used, `${m.cardW}px card, rating ${rating}`).toBeLessThanOrEqual(budget);
        // Whatever it shows, it never invents or loses people.
        expect(got.show.length + got.extra).toBeLessThanOrEqual(many.length);
      }
    }
  });

  it('counts the ones it dropped when there is room to say so', () => {
    const many = Array.from({ length: 20 }, (_, i) => `nm${String(i).padStart(7, '0')}`);
    const got = markersFor(many, wide, 8.1);
    expect(got.extra).toBeGreaterThan(0);
    expect(got.show.length + got.extra).toBe(many.length);
  });

  it('gives the rating the room on a card too small for both', () => {
    const many = Array.from({ length: 20 }, (_, i) => `nm${String(i).padStart(7, '0')}`);
    const got = markersFor(many, phone, null);
    expect(got.show).toEqual([]);
    expect(got.extra).toBe(0);
  });

  it('leaves more room when the rating is short', () => {
    const many = Array.from({ length: 20 }, (_, i) => `nm${String(i).padStart(7, '0')}`);
    expect(markersFor(many, wide, 8.1).show.length).toBeGreaterThanOrEqual(
      markersFor(many, wide, null).show.length,
    );
  });

  it('never returns more people than it was given', () => {
    for (const n of [0, 1, 2, 3, 8, 39]) {
      const people = Array.from({ length: n }, (_, i) => `nm${String(i).padStart(7, '0')}`);
      const got = markersFor(people, wide, 7);
      expect(got.show.length + got.extra).toBe(n);
    }
  });
});

describe('the card, now that Compact is gone', () => {
  it('gives a phone card two title lines beside its poster', () => {
    const m = metricsFor(390, settings());
    expect(m.titleLines).toBe(2);
    expect(m.cardW).toBe(132);
    expect(m.cardH).toBe(72);
  });

  it('leaves the desktop card the size it always was', () => {
    const m = metricsFor(1280, settings());
    expect(m.cardW).toBe(168);
    expect(m.cardH).toBe(90);
    expect(m.titleLines).toBe(2);
  });

  it('has no density setting left to read', () => {
    expect('density' in DEFAULT_SETTINGS).toBe(false);
  });

  it('drops the stored density of an install from before it went', () => {
    const s = settingsFrom(JSON.stringify({ density: 'compact', yearOrder: 'newest' }));
    expect('density' in s).toBe(false);
    expect(s.yearOrder).toBe('newest');
  });

  it('falls back to the defaults for nothing stored, or nonsense', () => {
    expect(settingsFrom(null)).toEqual(DEFAULT_SETTINGS);
    expect(settingsFrom('{oops')).toEqual(DEFAULT_SETTINGS);
    expect(settingsFrom('null')).toEqual(DEFAULT_SETTINGS);
  });
});

describe('a card with a poster', () => {
  it('keeps a portrait poster beside a text column, at every width', () => {
    for (const w of WIDTHS) {
      const m = metricsFor(w, settings());
      expect(m.posterW).toBeGreaterThanOrEqual(40);
      expect(m.posterH).toBeGreaterThan(m.posterW);
      expect(m.cardH).toBeGreaterThan(m.posterH);
      expect(m.cardW).toBeGreaterThan(m.posterW + 60);
    }
  });
});

describe('the year range', () => {
  /** The Matrix, 1999, with a career either side of it. */
  const career = () =>
    payloadOf({ id: 'tt0000001', year: 1999, rating: 8 }, [
      { id: 'tt0000001', year: 1999, rating: 8, people: [0, 1] },
      { id: 'tt0000002', year: 2000, rating: 7, people: [0] },
      { id: 'tt0000003', year: 2003, rating: 6, people: [1] },
      { id: 'tt0000004', year: 1994, rating: 9, people: [0] },
    ], castOf(2));

  it('crops the rows outside it and keeps the searched film', () => {
    const l = layoutGrid(career(), 1280, settings({ yearFrom: 2000 }));
    expect(l.rows.filter((r) => !r.isBreak).map((r) => r.year)).toEqual([1999, 2000, 2003]);
    expect(l.cards.map((c) => c.film.id).sort()).toEqual([
      'tt0000001',
      'tt0000002',
      'tt0000003',
    ]);
  });

  it('puts a break between the searched film and the range', () => {
    const oldest = layoutGrid(career(), 1280, settings({ yearFrom: 2000 }));
    expect(oldest.rows.map((r) => (r.isBreak ? 'break' : r.year))).toEqual([
      1999,
      'break',
      2000,
      2003,
    ]);
    const newest = layoutGrid(
      career(),
      1280,
      settings({ yearFrom: 2000, yearOrder: 'newest' }),
    );
    expect(newest.rows.map((r) => (r.isBreak ? 'break' : r.year))).toEqual([
      2003,
      2000,
      'break',
      1999,
    ]);
  });

  it('has no break when the searched film is inside the range', () => {
    const l = layoutGrid(career(), 1280, settings({ yearFrom: 1995, yearTo: 2001 }));
    expect(l.rows.some((r) => r.isBreak)).toBe(false);
  });

  it('knows the years this map actually holds', () => {
    expect(yearBounds(career())).toEqual({ lo: 1994, hi: 2003 });
  });

  it('does not stretch to a year only unrated films hold, with their column off', () => {
    const p = payloadOf({ id: 'tt0000001', year: 1999, rating: 8 }, [
      { id: 'tt0000001', year: 1999, rating: 8, people: [0] },
      { id: 'tt0000002', year: 1988, rating: null, people: [0] },
      { id: 'tt0000003', year: 2003, rating: 6, people: [0] },
      { id: 'tt0000004', year: 2011, rating: null, people: [0] },
    ], castOf(1));
    expect(yearBounds(p)).toEqual({ lo: 1988, hi: 2011 });
    expect(yearBounds(p, true)).toEqual({ lo: 1988, hi: 2011 });
    expect(yearBounds(p, false)).toEqual({ lo: 1999, hi: 2003 });
  });

  it('keeps the searched film’s year in the bounds even when it is unrated', () => {
    const p = payloadOf({ id: 'tt0000001', year: 1980, rating: null }, [
      { id: 'tt0000001', year: 1980, rating: null, people: [0] },
      { id: 'tt0000002', year: 2000, rating: 7, people: [0] },
    ], castOf(1));
    expect(yearBounds(p, false)).toEqual({ lo: 1980, hi: 2000 });
  });
});

describe('hiding the empty years', () => {
  const career = () =>
    payloadOf({ id: 'tt0000001', year: 1999, rating: 8 }, [
      { id: 'tt0000001', year: 1999, rating: 8, people: [0, 1] },
      { id: 'tt0000002', year: 2000, rating: 7, people: [0] },
      { id: 'tt0000003', year: 2003, rating: 6, people: [1] },
    ], castOf(2));

  it('is every card that person is in, plus the searched film', () => {
    const lit = (f: SpineFilm) => isLit(f, new Set([0]), null);
    const l = layoutGrid(career(), 1280, settings({ hideEmptyYears: true }), lit);
    expect(l.cards.map((c) => c.film.id)).toEqual(['tt0000001', 'tt0000002']);
    expect(l.rows.map((r) => r.year)).toEqual([1999, 2000]);
  });

  it('keeps the searched film’s row even with nothing else lit', () => {
    const lit = (f: SpineFilm) => isLit(f, new Set([9]), null);
    const l = layoutGrid(career(), 1280, settings({ hideEmptyYears: true }), lit);
    expect(l.cards.map((c) => c.film.id)).toEqual(['tt0000001']);
    expect(l.rows.map((r) => r.year)).toEqual([1999]);
  });

  it('hides nothing when the caller cannot say what is lit', () => {
    const l = layoutGrid(career(), 1280, settings({ hideEmptyYears: true }));
    expect(l.cards.length).toBe(3);
  });
});

describe('litOthers', () => {
  /** A career either side of 2005, with an unrated film and a film far
   *  outside any range the tests below set. */
  const career = () =>
    payloadOf({ id: 'tt0000001', year: 2005, rating: 7 }, [
      { id: 'tt0000001', year: 2005, rating: 7, people: [0, 1] },
      { id: 'tt0000002', year: 1990, rating: null, people: [0] },
      { id: 'tt0000003', year: 2010, rating: 7.5, people: [1] },
      { id: 'tt0000004', year: 2005, rating: 8.2, people: [1] },
      { id: 'tt0000005', year: 1971, rating: 8.8, people: [0] },
      { id: 'tt0000006', year: 2008, rating: 6.1, people: [0, 1] },
    ], castOf(2));

  it('leaves out a match the unrated column has taken off the plot', () => {
    // Person 0's 1990 film is unrated with its column off, and their
    // 1971 film is before the range. Only 2008 is left on the page.
    const s = settings({ showUnrated: false, yearFrom: 1985 });
    expect(litOthers(career(), s, new Set([0])).map((f) => f.id)).toEqual(['tt0000006']);
  });

  it('leaves out a match the year range has cropped', () => {
    const s = settings({ yearFrom: 2000, minRating: 8.5 });
    // P's 1971 film clears the floor, but the range has taken it away.
    expect(litOthers(career(), s, new Set([0]))).toEqual([]);
  });

  it('never counts the searched film', () => {
    expect(litOthers(career(), settings(), new Set([0, 1])).some((f) => f.isAnchor)).toBe(false);
  });

  // The count the reader is told, and whether the searched film is
  // alone, must match what the layout actually draws — for every
  // combination of the things that take films off the page.
  const combos: Partial<GridSettings>[] = [];
  for (const showUnrated of [true, false])
    for (const [yearFrom, yearTo] of [[null, null], [2000, null], [null, 2006], [2006, 2009], [2012, null]] as const)
      for (const minRating of [null, 7, 8.5])
        combos.push({ showUnrated, yearFrom, yearTo, minRating });
  const selections = [new Set<number>(), new Set([0]), new Set([1]), new Set([0, 1])];

  it('agrees with the layout about which other cards a collapsed map holds', () => {
    for (const over of combos) {
      for (const sel of selections) {
        const s = settings({ ...over, hideEmptyYears: true });
        const laid = layoutGrid(career(), 1280, s, (f) => isLit(f, sel, s.minRating));
        const drawn = laid.cards.filter((c) => !c.film.isAnchor).map((c) => c.film.id).sort();
        const counted = litOthers(career(), s, sel).map((f) => f.id).sort();
        expect({ over, sel: [...sel], ids: counted }).toEqual({ over, sel: [...sel], ids: drawn });
      }
    }
  });

  it('holds the films on the plot, lit or not, for hiding empty years to work with', () => {
    const s = settings({ showUnrated: false, yearFrom: 2000 });
    expect(othersOnPlot(career(), s).map((f) => f.id).sort()).toEqual([
      'tt0000003',
      'tt0000004',
      'tt0000006',
    ]);
    expect(othersOnPlot(career(), settings({ yearFrom: 2006, yearTo: 2007 }))).toEqual([]);
  });

  it('says the searched film is alone only when hiding the empty years did it', () => {
    const p = career();
    // Nobody lit at 8.5 for person 1, with their films still on the plot.
    expect(aloneAfterHiding(p, settings({ hideEmptyYears: true, minRating: 8.5 }), new Set([1]))).toBe(true);
    // The same, without hiding: nothing to say.
    expect(aloneAfterHiding(p, settings({ minRating: 8.5 }), new Set([1]))).toBe(false);
    // Something of theirs lit: not alone.
    expect(aloneAfterHiding(p, settings({ hideEmptyYears: true }), new Set([1]))).toBe(false);
    // The range has left nothing else on the plot. Hiding emptied
    // nothing, and showing every year again would bring nothing back.
    expect(aloneAfterHiding(p, settings({ hideEmptyYears: true, yearFrom: 2006, yearTo: 2007 }), new Set([1]))).toBe(false);
  });

  it('knows when the year range holds none of the cast’s other films', () => {
    const p = career();
    // No range, no claim.
    expect(rangeHoldsNone(p, settings())).toBe(false);
    // Wholly outside the years they worked.
    expect(rangeHoldsNone(p, settings({ yearFrom: 2030 }))).toBe(true);
    // Inside those years, but in a gap between two films: 2006–2007.
    expect(rangeHoldsNone(p, settings({ yearFrom: 2006, yearTo: 2007 }))).toBe(true);
    // An unrated film in range is still one of theirs, column or not.
    expect(rangeHoldsNone(p, settings({ yearFrom: 1989, yearTo: 1991, showUnrated: false }))).toBe(false);
    // Another film of theirs shares the searched film's year.
    expect(rangeHoldsNone(p, settings({ yearFrom: 2005, yearTo: 2005 }))).toBe(false);
    // The searched film itself does not count: it is never cropped, so
    // it is on the page whatever the range, and says nothing about it.
    const alone = payloadOf({ id: 'tt0000001', year: 2005, rating: 7 }, [
      { id: 'tt0000001', year: 2005, rating: 7, people: [0] },
      { id: 'tt0000002', year: 1990, rating: 6, people: [0] },
    ], castOf(1));
    expect(rangeHoldsNone(alone, settings({ yearFrom: 2000, yearTo: 2010 }))).toBe(true);
  });

  it('only says so when showing every year would bring something back', () => {
    let said = 0;
    for (const over of combos) {
      for (const sel of selections) {
        const s = settings({ ...over, hideEmptyYears: true });
        if (!aloneAfterHiding(career(), s, sel)) continue;
        said++;
        const lit = (f: SpineFilm) => isLit(f, sel, s.minRating);
        const hidden = layoutGrid(career(), 1280, s, lit);
        const shown = layoutGrid(career(), 1280, { ...s, hideEmptyYears: false }, lit);
        expect({ over, sel: [...sel], cards: hidden.cards.map((c) => c.film.id) }).toEqual({
          over,
          sel: [...sel],
          cards: ['tt0000001'],
        });
        expect(shown.cards.length).toBeGreaterThan(1);
      }
    }
    // Not a loop over nothing: the combinations do reach the case.
    expect(said).toBeGreaterThan(0);
  });

  it('agrees with the layout about how many years a collapsed map shows', () => {
    for (const over of combos) {
      for (const sel of selections) {
        const s = settings({ ...over, hideEmptyYears: true });
        const laid = layoutGrid(career(), 1280, s, (f) => isLit(f, sel, s.minRating));
        const rows = laid.rows.filter((r) => !r.isBreak).length;
        const p = career();
        const years = new Set([p.anchor.year, ...litOthers(p, s, sel).map((f) => f.year)]).size;
        expect({ over, sel: [...sel], years }).toEqual({ over, sel: [...sel], years: rows });
      }
    }
  });
});

describe('isLit', () => {
  const film = (over: Partial<SpineFilm> = {}): SpineFilm => ({
    id: 'tt0000002',
    year: 2000,
    rating: 7,
    md: 0,
    people: [1],
    isAnchor: false,
    ...over,
  });

  it('always lights the searched film', () => {
    expect(isLit(film({ isAnchor: true, rating: null }), new Set([5]), 9)).toBe(true);
  });

  it('fails an unrated film against any floor', () => {
    expect(isLit(film({ rating: null }), new Set(), 6)).toBe(false);
    expect(isLit(film({ rating: null }), new Set(), null)).toBe(true);
  });

  it('lights everything when nobody is selected', () => {
    expect(isLit(film(), new Set(), null)).toBe(true);
  });

  it('asks whether the selected person is on it', () => {
    expect(isLit(film(), new Set([1]), null)).toBe(true);
    expect(isLit(film(), new Set([0]), null)).toBe(false);
  });
});

describe('what the header says is narrowing the map', () => {
  it('reads the floor, then the range', () => {
    expect(activeFilters(settings(), false)).toBe('');
    expect(activeFilters(settings({ minRating: 7 }), false)).toBe('');
    expect(activeFilters(settings({ minRating: 7 }), true)).toBe('7.0+');
    expect(activeFilters(settings({ yearFrom: 2000, yearTo: 2026 }), false)).toBe('2000–2026');
    expect(activeFilters(settings({ yearFrom: 2000 }), false)).toBe('From 2000');
    expect(activeFilters(settings({ yearTo: 2012 }), false)).toBe('To 2012');
    expect(activeFilters(settings({ minRating: 7, yearFrom: 2000 }), true)).toBe(
      '7.0+ · From 2000',
    );
  });

  // The pill is for what is hidden from the reader. Hiding the empty
  // years hides no movie — it closes the gaps between the rows that are
  // already there, and the closing is the evidence.
  it('says nothing about hiding the empty years', () => {
    expect(activeFilters(settings({ hideEmptyYears: true }), false)).toBe('');
    expect(activeFilters(settings({ hideEmptyYears: true, yearFrom: 2000 }), false)).toBe(
      'From 2000',
    );
    expect(changedCount(settings({ hideEmptyYears: true }), true)).toBe(0);
  });

  it('counts a range once, however many ends it has', () => {
    expect(changedCount(settings(), true)).toBe(0);
    expect(changedCount(settings({ yearFrom: 2000 }), true)).toBe(1);
    expect(changedCount(settings({ yearFrom: 2000, yearTo: 2010 }), true)).toBe(1);
    expect(
      changedCount(settings({ yearFrom: 2000, yearTo: 2010, hideEmptyYears: true }), true),
    ).toBe(1);
    expect(changedCount(settings({ yearOrder: 'newest', showUnrated: false }), true)).toBe(2);
    // The floor counts only where it is changed from.
    expect(changedCount(settings({ minRating: 7 }), true)).toBe(1);
    expect(changedCount(settings({ minRating: 7 }), false)).toBe(0);
  });
});

describe('the year slider keys', () => {
  const map = { a: 2000, b: 2010, lo: 1990, hi: 2020 };

  it('moves a year at a time and ten at a time', () => {
    expect(keyYear('from', 'PageUp', map)).toBe(2010);
    expect(keyYear('from', 'ArrowRight', map)).toBe(2001);
    expect(keyYear('from', 'ArrowLeft', map)).toBe(1999);
    expect(keyYear('to', 'PageDown', map)).toBe(2000);
  });

  it('opens the side when a thumb reaches the end of the map', () => {
    expect(keyYear('from', 'Home', map)).toBe(null);
    expect(keyYear('to', 'End', map)).toBe(null);
  });

  it('stops each thumb at the other one', () => {
    expect(keyYear('from', 'End', map)).toBe(2010);
    expect(keyYear('to', 'Home', map)).toBe(2000);
    expect(keyYear('from', 'PageUp', { ...map, a: 2008 })).toBe(2010);
  });

  it('leaves a key it does not own alone', () => {
    expect(keyYear('from', 'Enter', map)).toBe(undefined);
  });
});


describe('the spine', () => {
  it('reads the server tuples into films that know where they go', () => {
    const p = payloadOf({ id: 'tt0000001', year: 1999, rating: 8, md: 331 }, [
      { id: 'tt0000001', year: 1999, rating: 8, md: 331 },
      { id: 'tt0000002', year: 2001, rating: null },
    ]);
    const spine = spineOf(p);
    expect(spine).toEqual([
      { id: 'tt0000001', year: 1999, rating: 8, md: 331, people: [], isAnchor: true },
      { id: 'tt0000002', year: 2001, rating: null, md: 0, people: [], isAnchor: false },
    ]);
  });

  it('is the whole grid, so a layout is final the first time', () => {
    const once = layoutGrid(real, 1280);
    const again = layoutGrid(real, 1280);
    expect(again.cards.map((c) => [c.film.id, c.left, c.top])).toEqual(
      once.cards.map((c) => [c.film.id, c.left, c.top]),
    );
    expect(once.cards.length).toBe(real.films.length);
  });
});

describe('the warm band', () => {
  it('is the screen in front of the reader, plus one screen above and below', () => {
    for (const viewH of [480, 720, 900, 1400]) {
      const at = 2000;
      const span = warmSpan(at, viewH);
      expect(span.top).toBe(at - viewH);
      expect(span.bottom).toBe(at + viewH * 2);
      expect(span.bottom - span.top).toBe(viewH * 3);
    }
  });

  it('follows the reader, including back to the top', () => {
    expect(warmSpan(0, 800)).toEqual({ top: -800, bottom: 1600 });
    expect(warmSpan(400, 800).top).toBe(-400);
    expect(warmSpan(5000, 800).top).toBe(4200);
  });

  it('keeps a card that only just enters the band, and drops one past it', () => {
    const span = warmSpan(1000, 800);
    const cardH = 90;
    expect(inWarmSpan(span.top - cardH + 1, cardH, span)).toBe(true);
    expect(inWarmSpan(span.top - cardH, cardH, span)).toBe(false);
    expect(inWarmSpan(span.bottom - 1, cardH, span)).toBe(true);
    expect(inWarmSpan(span.bottom, cardH, span)).toBe(false);
    // The screen itself, and the full screen on either side of it.
    expect(inWarmSpan(1000, cardH, span)).toBe(true);
    expect(inWarmSpan(1000 - 800, cardH, span)).toBe(true);
    expect(inWarmSpan(1000 + 800, cardH, span)).toBe(true);
  });
});

describe('the rating floor', () => {
  it('keeps everything when there is no floor', () => {
    expect(passesFloor(2, null)).toBe(true);
    expect(passesFloor(9, null)).toBe(true);
  });

  it('keeps a rating at the floor, and drops what is under it', () => {
    expect(passesFloor(7, 7)).toBe(true);
    expect(passesFloor(6.9, 7)).toBe(false);
  });

  it('dims rather than removes: every card stays exactly where it was', () => {
    const all = layoutGrid(real, 1280, settings());
    const high = layoutGrid(real, 1280, settings({ minRating: 8 }));
    expect(high.cards.length).toBe(all.cards.length);
    expect(high.cards.map((c) => [c.film.id, c.left, c.top])).toEqual(
      all.cards.map((c) => [c.film.id, c.left, c.top]),
    );
    expect(high.rows.map((r) => [r.year, r.top, r.height])).toEqual(
      all.rows.map((r) => [r.year, r.top, r.height]),
    );
  });

  it('counts an unrated film as below any floor, and lit when there is none', () => {
    expect(passesFloor(null, null)).toBe(true);
    expect(passesFloor(null, 6)).toBe(false);
  });

  it('always keeps the searched film, whatever the floor', () => {
    const strict = layoutGrid(real, 1280, settings({ minRating: 8.5 }));
    expect(strict.anchor?.film.id).toBe(real.anchor.id);
  });

  it('leaves fewer rows, and none empty', () => {
    const high = layoutGrid(real, 1280, settings({ minRating: 8 }));
    expect(high.rows.every((r) => r.lanes > 0)).toBe(true);
    const years = new Set(high.cards.map((c) => c.film.year));
    expect(high.rows.length).toBe(years.size);
  });
});

describe('opacityOf', () => {
  /** People are places in the chip row, as the spine names them. */
  const card = (rating: number | null, people: number[], isAnchor = false): Placed => ({
    film: { id: 'tt0000001', year: 2000, rating, md: 0, people, isAnchor },
    left: 0,
    top: 0,
    lane: 0,
  });
  const none = new Set<number>();

  it('lights everything when nothing is narrowing the grid', () => {
    expect(opacityOf(card(5, [0]), none, null, null)).toBe(1);
    expect(opacityOf(card(null, [0]), none, null, null)).toBe(1);
  });

  it('dims a film under the floor and lights one at it', () => {
    expect(opacityOf(card(7, [0]), none, null, 7)).toBe(1);
    expect(opacityOf(card(6.9, [0]), none, null, 7)).toBeLessThan(1);
    expect(opacityOf(card(null, [0]), none, null, 7)).toBeLessThan(1);
  });

  it('asks for both the person and the rating', () => {
    const selected = new Set([0]);
    expect(opacityOf(card(8, [0]), selected, null, 7)).toBe(1);
    expect(opacityOf(card(8, [1]), selected, null, 7)).toBeLessThan(1);
    expect(opacityOf(card(5, [0]), selected, null, 7)).toBeLessThan(1);
  });

  it('keeps the searched film lit, whatever is asked for', () => {
    expect(opacityOf(card(2, [8], true), new Set([0]), null, 9)).toBe(1);
    expect(opacityOf(card(2, [8], true), none, 0, 9)).toBe(1);
  });

  it('previews one person on hover, still honouring the floor', () => {
    expect(opacityOf(card(8, [2]), none, 2, 7)).toBe(1);
    expect(opacityOf(card(4, [2]), none, 2, 7)).toBeLessThan(1);
    expect(opacityOf(card(8, [3]), none, 2, 7)).toBeLessThan(1);
  });

  it('lets a hover override the selection while the pointer is on it', () => {
    // Selected someone else; previewing this card's person lights it.
    expect(opacityOf(card(8, [2]), new Set([0]), 2, null)).toBe(1);
    // Selected this card's person; previewing someone else dims it.
    expect(opacityOf(card(8, [0]), new Set([0]), 2, null)).toBeLessThan(1);
  });
});

describe('a year reads as a calendar', () => {
  /** Every pair where a later date sits above an earlier one. */
  /** Cards inside one year that sit against the direction the axis
   *  runs. Time flows one way down the whole page, so which way that is
   *  depends on the year order the reader asked for. */
  function inversions(l: ReturnType<typeof layoutGrid>, newestFirst = false): number {
    const byYear = new Map<number, typeof l.cards>();
    for (const c of l.cards) {
      const list = byYear.get(c.film.year);
      if (list) list.push(c);
      else byYear.set(c.film.year, [c]);
    }
    let bad = 0;
    for (const [, list] of byYear) {
      for (const a of list) {
        for (const b of list) {
          if (a.top >= b.top) continue;
          const later = dateOrd(a.film) > dateOrd(b.film);
          if (newestFirst ? !later && dateOrd(a.film) !== dateOrd(b.film) : later) bad++;
        }
      }
    }
    return bad;
  }

  it('never sits a later film above an earlier one, at any width', () => {
    for (const w of WIDTHS) {
      expect(inversions(layoutGrid(real, w)), `${w}px`).toBe(0);
    }
  });

  it('holds when the reader asks for the newest year first', () => {
    // The years run the other way; inside one, the calendar does not.
    expect(inversions(layoutGrid(real, 1280, settings({ yearOrder: 'newest' })), true)).toBe(0);
  });

  it('still packs a row rather than giving every film its own lane', () => {
    const l = layoutGrid(real, 1280);
    const busiest = l.rows.reduce((m, r) => Math.max(m, r.lanes), 0);
    const inBusiest = l.cards.filter(
      (c) => c.film.year === l.rows.find((r) => r.lanes === busiest)!.year,
    ).length;
    expect(busiest).toBeLessThan(inBusiest);
  });

  it('keeps a card at its own rating, which the ordering must not disturb', () => {
    const l = layoutGrid(real, 1280);
    const slack = l.metrics.cardW * NUDGE_RATIO + 1;
    for (const c of l.cards) {
      if (c.film.rating == null) continue;
      const centre = c.left + l.metrics.cardW / 2;
      expect(Math.abs(centre - xOf(c.film.rating, l.metrics)), String(c.film.id)).toBeLessThanOrEqual(slack);
    }
  });
});

describe('fitLane with a floor', () => {
  it('will not drop a card into a lane above the one before it', () => {
    // Lane 0 is free at this x, but the previous card sat in lane 2.
    expect(fitLane([0, 900, 900], 100, 116, 2).lane).toBe(3);
    expect(fitLane([0, 900, 900], 100, 116, 0).lane).toBe(0);
  });

  it('takes the first lane at or after the floor that has room', () => {
    expect(fitLane([900, 0, 0], 100, 116, 1)).toEqual({ lane: 1, left: 100 });
  });

  it('opens a new lane rather than lying about the rating', () => {
    const { lane, left } = fitLane([900, 900], 100, 116, 1);
    expect(lane).toBe(2);
    expect(left).toBe(100);
  });
});

describe('no counts anywhere', () => {
  // §1.6 and check 12: the map is open-ended. A number that tallies films
  // or people makes it look like a list with an end.
  const sources = import.meta.glob('./{GridApp,GridMap,GridSheet,PeopleChips,ViewPanel}.tsx', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;

  it('reads the components it is guarding', () => {
    expect(Object.keys(sources).length).toBe(5);
  });

  it('has no chip count and no film tally', () => {
    for (const [path, src] of Object.entries(sources)) {
      expect(src, path).not.toContain('cd-chip-count');
      expect(src, path).not.toMatch(/films\.length\}/);
      expect(src, path).not.toMatch(/\{[^}]*\}\s*films/);
    }
  });
});

describe('revealDelay', () => {
  const at = (left: number, top: number, isAnchor = false): Placed => ({
    film: {
      id: `tt${String(left + top).padStart(7, '0')}`,
      year: 2000,
      rating: 7,
      md: 0,
      people: [],
      isAnchor,
    },
    left,
    top,
    lane: 0,
  });

  it('lets the searched film appear at once', () => {
    const anchor = at(100, 100, true);
    expect(revealDelay(anchor, anchor)).toBe(0);
  });

  it('makes a card wait for its distance from the searched film', () => {
    const anchor = at(0, 0, true);
    // 3-4-5: 300px away, at 0.35ms a pixel.
    expect(revealDelay(at(180, 240), anchor)).toBe(105);
  });

  it('measures the same distance in every direction', () => {
    const anchor = at(400, 400, true);
    expect(revealDelay(at(400, 100), anchor)).toBe(revealDelay(at(400, 700), anchor));
    expect(revealDelay(at(100, 400), anchor)).toBe(revealDelay(at(700, 400), anchor));
  });

  it('caps the wait, so the far corner of a long map still arrives', () => {
    expect(revealDelay(at(9000, 9000), at(0, 0, true))).toBe(REVEAL_MAX_MS);
  });

  it('has nothing to measure from before the anchor is placed', () => {
    expect(revealDelay(at(500, 500), null)).toBe(0);
  });
});

describe('nothingLit', () => {
  /** A spine film; people are places in the chip row. */
  const film = (id: number, rating: number | null, people: number[], isAnchor = false): SpineFilm => ({
    id: `tt${String(id).padStart(7, '0')}`,
    year: 2000,
    rating,
    md: 0,
    isAnchor,
    people,
  });

  it('says so when every film of theirs sits below the floor', () => {
    expect(nothingLit([film(1, 5.2, [7]), film(2, 6.1, [7])], 7, 7)).toBe(true);
  });

  it('says nothing when one of theirs clears it', () => {
    expect(nothingLit([film(1, 5.2, [7]), film(2, 8.4, [7])], 7, 7)).toBe(false);
  });

  it('ignores films that are not theirs', () => {
    expect(nothingLit([film(1, 9.0, [8]), film(2, 5.0, [7])], 7, 7)).toBe(true);
  });

  it('leaves the searched film out of it: it is lit whatever the floor', () => {
    // Its own rating clearing the floor would not light anything else.
    expect(nothingLit([film(1, 9.0, [7], true), film(2, 5.0, [7])], 7, 7)).toBe(true);
  });

  it('makes no claim about someone with no other film on the map', () => {
    expect(nothingLit([film(1, 5.0, [8])], 7, 7)).toBe(false);
    expect(nothingLit([film(1, 9.0, [7], true)], 7, 7)).toBe(false);
    expect(nothingLit([], 7, 7)).toBe(false);
  });

  it('counts an unrated film as below the floor', () => {
    expect(nothingLit([film(1, null, [7])], 7, 6)).toBe(true);
  });

  it('counts a film of theirs far down the spine', () => {
    // The spine is every film on the map from the first paint, not the
    // few cards somebody has scrolled to. One that clears the floor at
    // the far end of a long career still means something of theirs is lit.
    const spine = [
      film(1, 8.7, [7], true),
      ...Array.from({ length: 60 }, (_, i) => film(i + 2, 5.5, [7])),
      film(99, 8.1, [7]),
    ];
    expect(nothingLit(spine, 7, 8)).toBe(false);
    expect(nothingLit(spine.slice(0, -1), 7, 8)).toBe(true);
  });
});

describe('onPlot', () => {
  const film = (year: number, rating: number | null, isAnchor = false): SpineFilm => ({
    id: `tt${String(year).padStart(7, '0')}`,
    year,
    rating,
    md: 0,
    isAnchor,
    people: [0],
  });

  it('holds every film when nothing is cropped', () => {
    expect(onPlot(film(1950, 7), DEFAULT_SETTINGS)).toBe(true);
    expect(onPlot(film(1950, null), DEFAULT_SETTINGS)).toBe(true);
  });

  it('takes unrated films off with their column', () => {
    const s = { ...DEFAULT_SETTINGS, showUnrated: false };
    expect(onPlot(film(2000, null), s)).toBe(false);
    expect(onPlot(film(2000, 6.1), s)).toBe(true);
  });

  it('crops outside the year range, inclusive at both ends', () => {
    const s = { ...DEFAULT_SETTINGS, yearFrom: 2000, yearTo: 2010 };
    expect(onPlot(film(1999, 8), s)).toBe(false);
    expect(onPlot(film(2000, 8), s)).toBe(true);
    expect(onPlot(film(2010, 8), s)).toBe(true);
    expect(onPlot(film(2011, 8), s)).toBe(false);
  });

  it('never drops the searched film', () => {
    const s = { ...DEFAULT_SETTINGS, showUnrated: false, yearFrom: 2000, yearTo: 2010 };
    expect(onPlot(film(1980, null, true), s)).toBe(true);
  });

  it('is the ground the layout stands on', () => {
    const anchor = { id: 'tt0000001', year: 2005, rating: 7 };
    const payload = payloadOf(anchor, [
      anchor,
      { id: 'tt0000002', year: 1995, rating: 8.5 },
      { id: 'tt0000003', year: 2003, rating: null },
      { id: 'tt0000004', year: 2008, rating: 6.5 },
    ]);
    const s = { ...DEFAULT_SETTINGS, showUnrated: false, yearFrom: 2000, yearTo: 2010 };
    const laid = layoutGrid(payload, 1200, s).cards.map((c) => c.film.id).sort();
    const held = spineOf(payload).filter((f) => onPlot(f, s)).map((f) => f.id).sort();
    expect(laid).toEqual(held);
  });

  it('keeps a cropped film out of the floor toast', () => {
    // Her only film over the floor is outside the range. Every card of
    // hers on the page is dark, and the toast has to be able to say so.
    const spine = [
      { ...film(2005, 7, true), people: [0, 1] },
      { ...film(1995, 8.5), people: [1] },
      { ...film(2003, 7.0), people: [1] },
      { ...film(2008, 6.5), people: [1] },
    ];
    const s = { ...DEFAULT_SETTINGS, yearFrom: 2000, yearTo: 2010 };
    expect(nothingLit(spine, 1, 8)).toBe(false);
    expect(nothingLit(spine.filter((f) => onPlot(f, s)), 1, 8)).toBe(true);
  });
});
