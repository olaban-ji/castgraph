import { describe, expect, it } from 'vitest';
import { groupByYear } from './FilmColumn';
import { GEOMETRY, LayoutCache, layoutTree, type PlacedFilm } from './layout';
import type { MapFilm, MapTree } from './tree';

function film(id: string, year: number, extra: Partial<MapFilm> = {}): MapFilm {
  return {
    id, year, trunk: false, anchor: false, side: 1, relation: 'X', relationPersonId: 'p:1', role: 'R', billing: 1, depth: 1,
    movie: { id, type: 'movie', label: id, tmdb_id: 1, year },
    ...extra,
  };
}

function placed(films: MapFilm[]): PlacedFilm[] {
  const tree: MapTree = {
    anchorId: films[0].id,
    films: new Map(films.map((f) => [f.id, f])),
    expanded: new Set(),
    deepened: new Set(),
    links: [],
  };
  return layoutTree(tree, new LayoutCache(GEOMETRY.phone)).placed;
}

describe('groupByYear', () => {
  it('is one section per year, oldest first: the column is the timeline', () => {
    const rows = groupByYear(placed([
      film('a', 1999, { anchor: true, trunk: true, depth: 0 }),
      film('b', 1975, { parent: 'a' }),
      film('c', 2010, { parent: 'a' }),
      film('d', 1975, { parent: 'a' }),
    ]));
    expect(rows.map(([year]) => year)).toEqual([1975, 1999, 2010]);
    expect(rows[0][1]).toHaveLength(2);
  });

  it('puts the searched film first in its year, then the closest hops', () => {
    const rows = groupByYear(placed([
      film('anchor', 1999, { anchor: true, trunk: true, depth: 0 }),
      film('far', 1999, { parent: 'anchor', depth: 3 }),
      film('near', 1999, { parent: 'anchor', depth: 1 }),
    ]));
    expect(rows[0][1].map((f) => f.id)).toEqual(['anchor', 'near', 'far']);
  });

  it('holds every film exactly once', () => {
    const films = [film('a', 1999, { anchor: true, trunk: true, depth: 0 })];
    for (let i = 0; i < 12; i++) films.push(film(`f${i}`, 1980 + i, { parent: 'a' }));
    const rows = groupByYear(placed(films));
    expect(rows.flatMap(([, list]) => list)).toHaveLength(13);
  });
});
