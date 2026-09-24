import { describe, expect, it } from 'vitest';
import { connectionsOf } from './FilmSheet';
import { GEOMETRY, LayoutCache, layoutTree, type Layout } from './layout';
import type { MapFilm, MapTree } from './tree';

function film(id: string, year: number, extra: Partial<MapFilm> = {}): MapFilm {
  return {
    id, year, trunk: false, anchor: false, side: 1, relation: 'X', relationPersonId: 'p:1', role: 'R', billing: 1, depth: 1,
    movie: { id, type: 'movie', label: id, tmdb_id: 1, year },
    ...extra,
  };
}

function built(): Layout {
  const tree: MapTree = {
    anchorId: 'a',
    films: new Map(
      [
        film('a', 1999, { anchor: true, trunk: true, depth: 0 }),
        film('b', 2003, { parent: 'a', depth: 1, relation: 'Keanu Reeves', role: 'Neo' }),
        film('c', 2013, { parent: 'a', side: -1, depth: 1, relation: 'Bong Joon Ho', role: 'Director' }),
      ].map((f) => [f.id, f]),
    ),
    expanded: new Set(),
    deepened: new Set(),
    links: [],
  };
  return layoutTree(tree, new LayoutCache(GEOMETRY.desktop));
}

function from(films: MapFilm[]): Layout {
  const tree: MapTree = {
    anchorId: 'a',
    films: new Map(films.map((f) => [f.id, f])),
    expanded: new Set(),
    deepened: new Set(),
    links: [],
  };
  return layoutTree(tree, new LayoutCache(GEOMETRY.desktop));
}

function many(): Layout {
  return from([
    film('a', 1999, { anchor: true, trunk: true, depth: 0 }),
    film('b', 2003, { parent: 'a', depth: 1, relation: 'Keanu Reeves', role: 'Neo' }),
    film('c', 2003, { parent: 'a', depth: 1, relation: 'Keanu Reeves', role: 'Neo' }),
    film('d', 2021, { parent: 'a', depth: 1, relation: 'Keanu Reeves', role: 'Neo' }),
    film('e', 2006, { parent: 'a', side: -1, depth: 1, relation: 'Hugo Weaving', role: 'Smith' }),
    film('f', 2008, { parent: 'a', side: -1, depth: 1, relation: 'Lana Wachowski', role: 'Director' }),
    film('g', 2012, { parent: 'a', side: -1, depth: 1, relation: 'Lana Wachowski', role: 'Director' }),
  ]);
}

function bothRoles(): Layout {
  return from([
    film('a', 1992, { anchor: true, trunk: true, depth: 0 }),
    film('b', 2004, { parent: 'a', depth: 1, relation: 'Clint Eastwood', role: 'Frankie' }),
    film('c', 2008, { parent: 'a', side: -1, depth: 1, relation: 'Clint Eastwood', role: 'Director' }),
  ]);
}

describe('connectionsOf', () => {
  it('states the tooltip as text: who, what they did, and in which film', () => {
    const rows = connectionsOf(built(), 'b');
    expect(rows).toHaveLength(1);
    expect(rows[0].person).toBe('Keanu Reeves');
    expect(rows[0].detail).toBe('as Neo · a');
    expect(rows[0].director).toBe(false);
  });

  it('separates a directing relation so the sheet can group it', () => {
    const rows = connectionsOf(built(), 'c');
    expect(rows[0].director).toBe(true);
    expect(rows[0].detail).toBe('directed · a');
  });

  it('gathers every edge touching the searched film', () => {
    expect(connectionsOf(built(), 'a')).toHaveLength(2);
  });

  it('is empty for a film nothing reaches yet', () => {
    expect(connectionsOf(built(), 'm:none')).toEqual([]);
  });

  it('gives a person one row however many films they tie in', () => {
    const rows = connectionsOf(many(), 'a');
    const keanu = rows.filter((r) => r.person === 'Keanu Reeves');
    expect(keanu).toHaveLength(1);
    expect(keanu[0].films).toBe(3);
    expect(keanu[0].detail).toBe('in 3 of these movies');
  });

  it('says a director ties several films rather than naming only the first', () => {
    const lana = connectionsOf(many(), 'a').find((r) => r.person === 'Lana Wachowski');
    expect(lana?.films).toBe(2);
    expect(lana?.detail).toBe('directed 2 of these movies');
  });

  it('puts the people holding most of the map together first', () => {
    expect(connectionsOf(many(), 'a').map((r) => r.person)).toEqual([
      'Keanu Reeves',
      'Lana Wachowski',
      'Hugo Weaving',
    ]);
  });

  it('keeps acting and directing apart for the same person', () => {
    const rows = connectionsOf(bothRoles(), 'a');
    expect(rows.map((r) => [r.person, r.director])).toEqual([
      ['Clint Eastwood', false],
      ['Clint Eastwood', true],
    ]);
  });
});
