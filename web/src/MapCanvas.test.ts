import { describe, expect, it } from 'vitest';
import { edgesAlong } from './MapCanvas';
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
  return { anchorId: films[0].id, films: new Map(films.map((f) => [f.id, f])), expanded: new Set() };
}

describe('edgesAlong', () => {
  const layout = layoutTree(
    tree([
      film('a', 1999, { trunk: true, anchor: true, depth: 0 }),
      film('b', 1991, { trunk: true, depth: 0 }),
      film('c', 2005, { trunk: true, depth: 0 }),
      film('d', 1980, { parent: 'a', side: -1 }),
      film('e', 2010, { parent: 'd', side: -1 }),
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

  it('lights the trunk segments a trunk stop sits on, not its branches', () => {
    const lit = edgesAlong(layout, { kind: 'film', filmId: 'a', edge: null, x: 0, y: 0 });
    const ids = [...lit];
    expect(ids.every((id) => id.startsWith('t-'))).toBe(true);
    expect(ids.some((id) => id.includes('d'))).toBe(false);
    expect(ids.length).toBe(2);
  });
});
