import { describe, expect, it } from 'vitest';
import { edgesAlong, paintWindow } from './MapCanvas';
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
  return { anchorId: films[0].id, films: new Map(films.map((f) => [f.id, f])), expanded: new Set(), links: [] };
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
