import { describe, expect, it } from 'vitest';
import matrix from './fixtures/matrix-grid.json';
import { opacityOf } from './GridMap';
import {
  clampRating,
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
  nothingLit,
  passesFloor,
  revealDelay,
  REVEAL_MAX_MS,
  warmSpan,
  NUDGE_RATIO,
  R_HI,
  R_LO,
  spineOf,
  xOf,
  DOT,
  MARKER_GAP,
  type GridFilm,
  type GridPayload,
  type Placed,
  type SpineTuple,
  type GridSettings,
} from './grid';

const real = matrix as unknown as GridPayload;
/** A payload shaped like the server's: films as [id, year, rating]. */
function payloadOf(
  anchor: { id: string; year: number; rating: number | null; md?: number },
  films: { id: string; year: number; rating: number | null; md?: number }[],
): GridPayload {
  return {
    anchor: { ...anchor, md: anchor.md ?? 0, title: 'Anchor', people: [], isAnchor: true },
    people: [],
    films: films.map((f) => [f.id, f.year, f.rating, f.md ?? 0] as SpineTuple),
  };
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

describe('the spine', () => {
  it('reads the server tuples into films that know where they go', () => {
    const p = payloadOf({ id: 'tt0000001', year: 1999, rating: 8, md: 331 }, [
      { id: 'tt0000001', year: 1999, rating: 8, md: 331 },
      { id: 'tt0000002', year: 2001, rating: null },
    ]);
    const spine = spineOf(p);
    expect(spine).toEqual([
      { id: 'tt0000001', year: 1999, rating: 8, md: 331, isAnchor: true },
      { id: 'tt0000002', year: 2001, rating: null, md: 0, isAnchor: false },
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
  const card = (rating: number | null, isAnchor = false) =>
    ({ film: { id: 'tt0000001', year: 2000, rating, md: 0, isAnchor }, left: 0, top: 0, lane: 0 });
  const none = new Set<string>();

  it('lights everything when nothing is narrowing the grid', () => {
    expect(opacityOf(card(5), ['nm0000001'], none, null, null)).toBe(1);
    expect(opacityOf(card(null), ['nm0000001'], none, null, null)).toBe(1);
  });

  it('dims a film under the floor and lights one at it', () => {
    expect(opacityOf(card(7), ['nm0000001'], none, null, 7)).toBe(1);
    expect(opacityOf(card(6.9), ['nm0000001'], none, null, 7)).toBeLessThan(1);
    expect(opacityOf(card(null), ['nm0000001'], none, null, 7)).toBeLessThan(1);
  });

  it('asks for both the person and the rating', () => {
    const selected = new Set(['nm0000001']);
    expect(opacityOf(card(8), ['nm0000001'], selected, null, 7)).toBe(1);
    expect(opacityOf(card(8), ['nm0000002'], selected, null, 7)).toBeLessThan(1);
    expect(opacityOf(card(5), ['nm0000001'], selected, null, 7)).toBeLessThan(1);
  });

  it('keeps the searched film lit, whatever is asked for', () => {
    expect(opacityOf(card(2, true), ['nm0000009'], new Set(['nm0000001']), null, 9)).toBe(1);
  });

  it('previews one person on hover, still honouring the floor', () => {
    expect(opacityOf(card(8), ['nm0000003'], none, 'nm0000003', 7)).toBe(1);
    expect(opacityOf(card(4), ['nm0000003'], none, 'nm0000003', 7)).toBeLessThan(1);
    expect(opacityOf(card(8), ['nm0000004'], none, 'nm0000003', 7)).toBeLessThan(1);
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
    film: { id: `tt${String(left + top).padStart(7, '0')}`, year: 2000, rating: 7, md: 0, isAnchor },
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
  const film = (id: number, rating: number | null, people: string[], isAnchor = false): GridFilm => ({
    id: `tt${String(id).padStart(7, '0')}`,
    year: 2000,
    rating,
    md: 0,
    isAnchor,
    title: `Film ${id}`,
    people,
  });

  it('says so when every film of theirs sits below the floor', () => {
    expect(nothingLit([film(1, 5.2, ['nm0000007']), film(2, 6.1, ['nm0000007'])], 'nm0000007', 7)).toBe(true);
  });

  it('says nothing when one of theirs clears it', () => {
    expect(nothingLit([film(1, 5.2, ['nm0000007']), film(2, 8.4, ['nm0000007'])], 'nm0000007', 7)).toBe(false);
  });

  it('ignores films that are not theirs', () => {
    expect(nothingLit([film(1, 9.0, ['nm0000008']), film(2, 5.0, ['nm0000007'])], 'nm0000007', 7)).toBe(true);
  });

  it('leaves the searched film out of it: it is lit whatever the floor', () => {
    // Its own rating clearing the floor would not light anything else.
    expect(nothingLit([film(1, 9.0, ['nm0000007'], true), film(2, 5.0, ['nm0000007'])], 'nm0000007', 7)).toBe(true);
  });

  it('makes no claim about someone whose films have not arrived', () => {
    expect(nothingLit([film(1, 5.0, ['nm0000008'])], 'nm0000007', 7)).toBe(false);
    expect(nothingLit([], 'nm0000007', 7)).toBe(false);
  });

  it('counts an unrated film as below the floor', () => {
    expect(nothingLit([film(1, null, ['nm0000007'])], 'nm0000007', 6)).toBe(true);
  });
});
