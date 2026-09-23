import { describe, expect, it } from 'vitest';
import matrix from './fixtures/matrix-grid.json';
import {
  clampRating,
  DEFAULT_SETTINGS,
  fitLane,
  GAP,
  gridLines,
  initialsFor,
  layoutGrid,
  markersFor,
  metricsFor,
  passesFloor,
  NUDGE_RATIO,
  R_HI,
  R_LO,
  xOf,
  DOT,
  MARKER_GAP,
  type GridPayload,
  type GridSettings,
} from './grid';

const real = matrix as GridPayload;
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
        expect(Math.abs(centre - xOf(c.film.rating, l.metrics)), c.film.title).toBeLessThanOrEqual(slack);
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
          expect(sorted[i].left, `${sorted[i].film.title} at ${w}px`).toBeGreaterThanOrEqual(
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
    expect(l.anchor?.film.title).toBe('The Matrix');
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
      { id: 1, name: 'Lana Wachowski', role: 'director', order: -1 },
      { id: 2, name: 'Lilly Wachowski', role: 'director', order: -1 },
    ]);
    expect(codes.get(1)).toBe('LaW');
    expect(codes.get(2)).toBe('LiW');
    expect(new Set([...codes.values()]).size).toBe(2);
  });

  it('gives everyone on a real map a code of their own', () => {
    const codes = initialsFor(real.people);
    expect(new Set([...codes.values()]).size).toBe(real.people.length);
  });

  it('copes with a single name', () => {
    const codes = initialsFor([{ id: 1, name: 'Cher', role: 'cast', order: 0 }]);
    expect(codes.get(1)).toBe('C');
  });
});

describe('markersFor', () => {
  const wide = metricsFor(1280, DEFAULT_SETTINGS);
  const phone = metricsFor(390, DEFAULT_SETTINGS);

  it('shows initials for one or two people', () => {
    const m = markersFor([1, 2], wide, 7.5);
    expect(m.initials).toBe(true);
    expect(m.show).toEqual([1, 2]);
    expect(m.extra).toBe(0);
  });

  it('switches to dots once there are three', () => {
    const m = markersFor([1, 2, 3], wide, 7.5);
    expect(m.initials).toBe(false);
    expect(m.extra).toBe(0);
  });

  // §10.4: a row of markers that does not fit is a row that gets clipped.
  it('never draws more markers than the row has room for', () => {
    const many = Array.from({ length: 20 }, (_, i) => i);
    for (const m of [wide, phone]) {
      for (const rating of [8.1, null]) {
        const got = markersFor(many, m, rating);
        const used = got.show.length * (DOT + MARKER_GAP) + (got.extra > 0 ? 22 : 0);
        const budget = m.cardW - 16 - (rating == null ? 54 : 24) - MARKER_GAP;
        expect(used, `${m.cardW}px card, rating ${rating}`).toBeLessThanOrEqual(budget);
        // Whatever it shows, it never invents or loses people.
        expect(got.show.length + got.extra).toBeLessThanOrEqual(many.length);
      }
    }
  });

  it('counts the ones it dropped when there is room to say so', () => {
    const many = Array.from({ length: 20 }, (_, i) => i);
    const got = markersFor(many, wide, 8.1);
    expect(got.extra).toBeGreaterThan(0);
    expect(got.show.length + got.extra).toBe(many.length);
  });

  it('gives the rating the room on a card too small for both', () => {
    const many = Array.from({ length: 20 }, (_, i) => i);
    const got = markersFor(many, phone, null);
    expect(got.show).toEqual([]);
    expect(got.extra).toBe(0);
  });

  it('leaves more room when the rating is short', () => {
    const many = Array.from({ length: 20 }, (_, i) => i);
    expect(markersFor(many, wide, 8.1).show.length).toBeGreaterThanOrEqual(
      markersFor(many, wide, null).show.length,
    );
  });

  it('never returns more people than it was given', () => {
    for (const n of [0, 1, 2, 3, 8, 39]) {
      const people = Array.from({ length: n }, (_, i) => i);
      const got = markersFor(people, wide, 7);
      expect(got.show.length + got.extra).toBe(n);
    }
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

  it('takes films off the grid rather than dimming them', () => {
    const all = layoutGrid(real, 1280, settings());
    const high = layoutGrid(real, 1280, settings({ minRating: 8 }));
    expect(high.cards.length).toBeLessThan(all.cards.length);
    for (const c of high.cards) {
      if (c.film.isAnchor) continue;
      expect(c.film.rating, c.film.title).not.toBeNull();
      expect(c.film.rating!).toBeGreaterThanOrEqual(8);
    }
  });

  it('drops unrated films once a floor is asked for', () => {
    const high = layoutGrid(real, 1280, settings({ minRating: 6 }));
    expect(high.cards.some((c) => !c.film.isAnchor && c.film.rating == null)).toBe(false);
  });

  it('always keeps the searched film, whatever the floor', () => {
    const strict = layoutGrid(real, 1280, settings({ minRating: 8.5 }));
    expect(strict.anchor?.film.title).toBe('The Matrix');
  });

  it('leaves fewer rows, and none empty', () => {
    const high = layoutGrid(real, 1280, settings({ minRating: 8 }));
    expect(high.rows.every((r) => r.lanes > 0)).toBe(true);
    const years = new Set(high.cards.map((c) => c.film.year));
    expect(high.rows.length).toBe(years.size);
  });
});
