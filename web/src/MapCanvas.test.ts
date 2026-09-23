import { describe, expect, it } from 'vitest';
import { edgeWidth, edgesOf, holdFilms, inYearOrder, linkedFilms, nearestToCentre, paintWindow, stickyPaintWindow } from './MapCanvas';
import { GEOMETRY, LayoutCache, layoutTree } from './layout';
import type { MapFilm, MapTree } from './tree';

function film(id: string, year: number, extra: Partial<MapFilm> = {}): MapFilm {
  return {
    id, year, trunk: false, anchor: false, side: 1, relation: 'X', relationPersonId: 'p:1', role: 'R', billing: 1, depth: 1,
    movie: { id, type: 'movie', label: id, tmdb_id: 1, year },
    ...extra,
  };
}

function tree(films: MapFilm[]): MapTree {
  return { anchorId: films[0].id, films: new Map(films.map((f) => [f.id, f])), expanded: new Set(), deepened: new Set(), links: [] };
}

/** A small map: an anchor, two hops off it, and one extra link that is
 *  not a placement parent. */
function built() {
  const t = tree([
    film('a', 1999, { trunk: true, anchor: true, depth: 0 }),
    film('b', 2003, { parent: 'a', side: 1, depth: 1 }),
    film('c', 2008, { parent: 'b', side: 1, depth: 2 }),
  ]);
  t.links.push({ from: 'a', to: 'c', relation: 'X', relationPersonId: 'p:2', role: 'R', billing: 2 });
  return layoutTree(t, new LayoutCache(GEOMETRY.desktop));
}

describe('edgesOf', () => {
  it('lights every edge of a film, and nothing else', () => {
    const l = built();
    const ids = edgesOf(l, 'b');
    for (const e of l.edges) {
      const touches = e.from.id === 'b' || e.to.id === 'b';
      expect(ids.has(e.id)).toBe(touches);
    }
    expect(ids.size).toBeGreaterThan(0);
  });

  it('includes extra network links, not just the placement parent', () => {
    const l = built();
    const ids = edgesOf(l, 'c');
    expect([...ids].some((id) => id.startsWith('n-'))).toBe(true);
  });
});

describe('linkedFilms', () => {
  it('names the films on either side of a card, and not the card itself', () => {
    const l = built();
    expect(linkedFilms(l, 'b')).toEqual(new Set(['a', 'c']));
    expect(linkedFilms(l, 'a')).toEqual(new Set(['b', 'c']));
  });
});

describe('edgeWidth', () => {
  it('thins with billing and stops at the floor', () => {
    expect(edgeWidth(1, false)).toBe(3);
    expect(edgeWidth(3, false)).toBeCloseTo(2.5);
    expect(edgeWidth(20, false)).toBe(1.5);
  });

  it('gives a directing relation the full weight: it has no billing', () => {
    expect(edgeWidth(99, true)).toBe(3);
  });
});

describe('nearestToCentre', () => {
  it('picks the card nearest the middle of the window, for a screen with no pointer', () => {
    const l = built();
    const centre = { sx: 0, sy: 0, vw: 2000, vh: 2000 };
    const id = nearestToCentre(l.placed, centre);
    const best = l.placed.reduce((acc, p) =>
      Math.hypot(p.x - 1000, p.y - 1000) < Math.hypot(acc.x - 1000, acc.y - 1000) ? p : acc,
    );
    expect(id).toBe(best.id);
  });

  it('is null with nothing mounted', () => {
    expect(nearestToCentre([], { sx: 0, sy: 0, vw: 100, vh: 100 })).toBeNull();
  });
});

describe('paintWindow', () => {
  it('covers the viewport plus overscan, clamped to the stage', () => {
    expect(paintWindow(100, 200, 400, 800, 5000, 8000, 360)).toEqual({
      left: 0,
      top: 0,
      width: 860,
      height: 1360,
    });
    expect(paintWindow(2000, 3000, 400, 800, 5000, 8000, 360)).toEqual({
      left: 1640,
      top: 2640,
      width: 1120,
      height: 1520,
    });
  });

  it('does not exceed the stage at the far edge', () => {
    expect(paintWindow(4800, 7600, 400, 800, 5000, 8000, 360)).toEqual({
      left: 4440,
      top: 7240,
      width: 560,
      height: 760,
    });
  });
});

describe('stickyPaintWindow', () => {
  const overscan = 360;
  const slack = 120;
  const view = (sx: number, sy: number) => ({
    sx, sy, vw: 400, vh: 800, stageW: 5000, stageH: 8000,
  });

  it('returns a fresh window when there is no previous', () => {
    expect(stickyPaintWindow(null, view(2000, 3000), overscan, slack)).toEqual(
      paintWindow(2000, 3000, 400, 800, 5000, 8000, overscan),
    );
  });

  it('keeps the previous window while the camera stays inside the slack', () => {
    const prev = paintWindow(2000, 3000, 400, 800, 5000, 8000, overscan);
    const same = stickyPaintWindow(prev, view(2050, 3080), overscan, slack);
    expect(same).toBe(prev);
  });

  it('recentres when the camera nears the painted edge', () => {
    const prev = paintWindow(2000, 3000, 400, 800, 5000, 8000, overscan);
    const next = stickyPaintWindow(prev, view(2000, 3300), overscan, slack);
    expect(next).not.toBe(prev);
    expect(next).toEqual(paintWindow(2000, 3300, 400, 800, 5000, 8000, overscan));
  });

  it('does not thrash at the stage origin', () => {
    const prev = paintWindow(100, 200, 400, 800, 5000, 8000, overscan);
    expect(stickyPaintWindow(prev, view(120, 220), overscan, slack)).toBe(prev);
  });
});

describe('holdFilms', () => {
  const layout = layoutTree(
    tree([
      film('a', 1999, { trunk: true, anchor: true, depth: 0 }),
      film('b', 1991, { parent: 'a', side: 1, depth: 1, trunk: true }),
      film('c', 2005, { parent: 'a', side: -1, depth: 1, trunk: true }),
    ]),
    new LayoutCache(GEOMETRY.desktop),
  );
  const a = layout.byId.get('a')!;
  const b = layout.byId.get('b')!;
  const c = layout.byId.get('c')!;

  it('adds films that entered', () => {
    expect(holdFilms(new Set(), [a], [a, b], layout.byId).map((f) => f.id)).toEqual(['a']);
  });

  it('keeps a film that left the enter band but is still in keep', () => {
    expect(holdFilms(new Set(['a', 'b']), [b], [a, b, c], layout.byId).map((f) => f.id).sort()).toEqual(['a', 'b']);
  });

  it('drops a film that left the keep band', () => {
    expect(holdFilms(new Set(['a', 'b']), [b], [b, c], layout.byId).map((f) => f.id)).toEqual(['b']);
  });

  it('drops ids that are no longer in the layout', () => {
    expect(holdFilms(new Set(['gone']), [], [], layout.byId)).toEqual([]);
  });
});

describe('inYearOrder', () => {
  it('is the order a reader travels the map, so DOM order is tab order', () => {
    const l = built();
    const shuffled = [...l.placed].reverse();
    const order = inYearOrder(shuffled);
    for (let i = 1; i < order.length; i++) {
      expect(order[i].year).toBeGreaterThanOrEqual(order[i - 1].year);
    }
  });

  it('breaks a tie left to right', () => {
    const a = { ...built().placed[0], id: 'right', x: 900, year: 2000 };
    const b = { ...a, id: 'left', x: 100 };
    expect(inYearOrder([a, b]).map((f) => f.id)).toEqual(['left', 'right']);
  });

  it('does not mutate what it was given', () => {
    const films = built().placed;
    const before = films.map((f) => f.id);
    inYearOrder(films);
    expect(films.map((f) => f.id)).toEqual(before);
  });
});
