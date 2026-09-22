import { describe, expect, it } from 'vitest';
import { edgesAlong, holdFilms, paintWindow, stickyPaintWindow } from './MapCanvas';
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

describe('edgesAlong', () => {
  const layout = layoutTree(
    tree([
      film('a', 1999, { trunk: true, anchor: true, depth: 0 }),
      film('b', 1991, { parent: 'a', side: 1, depth: 1, trunk: true }),
      film('c', 2005, { parent: 'a', side: -1, depth: 1, trunk: true }),
      film('d', 1980, { parent: 'a', side: -1, depth: 1, trunk: true }),
      film('e', 2010, { parent: 'd', side: -1, depth: 2 }),
    ]),
    new LayoutCache(GEOMETRY.desktop),
  );

  it('lights only the hovered line, not the path back to the anchor', () => {
    const branch = layout.edges.find((e) => e.to.id === 'e')!;
    expect([...edgesAlong(layout, { kind: 'edge', edge: branch, x: 0, y: 0 })]).toEqual([branch.id]);
  });

  it('lights a branch film’s incoming line only', () => {
    const lit = edgesAlong(layout, { kind: 'film', filmId: 'e', edge: null, x: 0, y: 0 });
    expect([...lit]).toEqual([layout.edges.find((e) => e.to.id === 'e')!.id]);
  });

  it('lights every edge of a film, including extra network links', () => {
    const lit = edgesAlong(layout, { kind: 'film', filmId: 'a', edge: null, x: 0, y: 0 });
    const ids = [...lit];
    expect(ids.every((id) => id.startsWith('b-') && id.includes('a'))).toBe(true);
    expect(ids.some((id) => id.includes('d'))).toBe(true);
    expect(ids.length).toBe(3);
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
