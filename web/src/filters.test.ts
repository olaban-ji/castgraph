import { describe, expect, it } from 'vitest';
import { countActive } from './FilterPanel';
import {
  edgeVisible,
  filterSummary,
  isFiltered,
  NO_FILTERS,
  peopleOnMap,
  ratingOf,
  visibleFilms,
  yearBounds,
  type MapFilters,
} from './filters';
import { GEOMETRY, LayoutCache, layoutTree, type Layout } from './layout';
import type { ApiNode } from './api';
import type { MapFilm, MapTree } from './tree';

function film(id: string, year: number, extra: Partial<MapFilm> = {}, movie: Partial<ApiNode> = {}): MapFilm {
  return {
    id, year, trunk: false, anchor: false, side: 1, relation: 'Keanu Reeves', relationPersonId: 'p:1',
    role: 'Neo', billing: 1, depth: 1,
    movie: { id, type: 'movie', label: id, tmdb_id: 1, year, ...movie },
    ...extra,
  };
}

/** anchor 1999 · b 2003 (Keanu, 8.5) · c 2013 (Bong, director, 6.0) */
function built(): Layout {
  const films = [
    film('a', 1999, { anchor: true, trunk: true, depth: 0 }, { imdb_rating: 8.7 }),
    film('b', 2003, { parent: 'a' }, { imdb_rating: 8.5 }),
    film('c', 2013, { parent: 'a', side: -1, relation: 'Bong Joon Ho', role: 'Director' }, { rating: 6 }),
    film('d', 2018, { parent: 'b', relation: 'Carrie-Anne Moss', role: 'Trinity' }, {}),
  ];
  const tree: MapTree = {
    anchorId: 'a',
    films: new Map(films.map((f) => [f.id, f])),
    expanded: new Set(),
    deepened: new Set(),
    links: [],
  };
  return layoutTree(tree, new LayoutCache(GEOMETRY.desktop));
}

const with_ = (over: Partial<MapFilters>): MapFilters => ({ ...NO_FILTERS, ...over });

describe('isFiltered', () => {
  it('is false for the default view and true for anything narrowed', () => {
    expect(isFiltered(NO_FILTERS)).toBe(false);
    expect(isFiltered(with_({ minRating: 7 }))).toBe(true);
    expect(isFiltered(with_({ person: 'Keanu Reeves' }))).toBe(true);
    expect(isFiltered(with_({ fromYear: 2000 }))).toBe(true);
    expect(isFiltered(with_({ director: false }))).toBe(true);
  });
});

describe('visibleFilms', () => {
  it('is null when nothing is filtered, so the map pays nothing', () => {
    expect(visibleFilms(built(), NO_FILTERS)).toBeNull();
  });

  it('keeps the searched film whatever the filter says', () => {
    const ids = visibleFilms(built(), with_({ fromYear: 2020 }))!;
    expect(ids.has('a')).toBe(true);
    expect(ids.size).toBe(1);
  });

  it('filters by year window, inclusive at both ends', () => {
    const ids = visibleFilms(built(), with_({ fromYear: 2003, toYear: 2013 }))!;
    expect([...ids].sort()).toEqual(['a', 'b', 'c']);
  });

  it('filters by rating, and hides films that have none when a floor is set', () => {
    const ids = visibleFilms(built(), with_({ minRating: 7 }))!;
    expect(ids.has('b')).toBe(true);   // 8.5
    expect(ids.has('c')).toBe(false);  // 6.0
    expect(ids.has('d')).toBe(false);  // unrated: cannot be shown to qualify
  });

  it('prefers the IMDb rating and falls back to TMDb', () => {
    const l = built();
    expect(ratingOf(l.byId.get('b')!)).toBe(8.5);
    expect(ratingOf(l.byId.get('c')!)).toBe(6);
    expect(ratingOf(l.byId.get('d')!)).toBeNull();
  });

  it('filters to one person: the films they connect, and nothing else', () => {
    const ids = visibleFilms(built(), with_({ person: 'Carrie-Anne Moss' }))!;
    expect([...ids].sort()).toEqual(['a', 'b', 'd']); // a is the anchor
  });

  it('drops a film whose only connection was the relation type switched off', () => {
    const ids = visibleFilms(built(), with_({ director: false }))!;
    expect(ids.has('c')).toBe(false);
    expect(ids.has('b')).toBe(true);
  });
});

describe('edgeVisible', () => {
  it('hides a relation type that is switched off', () => {
    const l = built();
    const direct = l.edges.find((e) => e.director)!;
    const cast = l.edges.find((e) => !e.director)!;
    expect(edgeVisible(direct, with_({ director: false }), null)).toBe(false);
    expect(edgeVisible(cast, with_({ director: false }), null)).toBe(true);
  });

  it('hides an edge whose film has been filtered out', () => {
    const l = built();
    const e = l.edges.find((x) => x.to.id === 'd')!;
    expect(edgeVisible(e, with_({ minRating: 7 }), visibleFilms(l, with_({ minRating: 7 })))).toBe(false);
  });

  it('keeps only the chosen person’s lines', () => {
    const l = built();
    const f = with_({ person: 'Carrie-Anne Moss' });
    const ids = visibleFilms(l, f);
    const kept = l.edges.filter((e) => edgeVisible(e, f, ids));
    expect(kept).toHaveLength(1);
    expect(kept[0].actor).toBe('Carrie-Anne Moss');
  });
});

describe('peopleOnMap', () => {
  it('is everyone the map connects through, most films first', () => {
    const people = peopleOnMap(built().edges);
    expect(people.map((p) => p.name)).toContain('Keanu Reeves');
    expect(people[0].films).toBeGreaterThanOrEqual(people[people.length - 1].films);
  });

  it('marks who reached the map as a director', () => {
    const bong = peopleOnMap(built().edges).find((p) => p.name === 'Bong Joon Ho')!;
    expect(bong.director).toBe(true);
  });
});

describe('yearBounds', () => {
  it('spans the map', () => {
    expect(yearBounds(built().placed)).toEqual({ min: 1999, max: 2018 });
  });

  it('is zeroed for an empty map rather than infinite', () => {
    expect(yearBounds([])).toEqual({ min: 0, max: 0 });
  });
});

describe('filterSummary', () => {
  it('counts plainly, and says what is hidden only when something is', () => {
    expect(filterSummary(NO_FILTERS, 12, 12)).toBe('12 films');
    expect(filterSummary(with_({ minRating: 7 }), 5, 12)).toBe('5 of 12 films');
  });
});

describe('countActive', () => {
  it('counts the narrowings the panel owns, not the relation chips', () => {
    expect(countActive(NO_FILTERS)).toBe(0);
    expect(countActive(with_({ cast: false }))).toBe(0);
    expect(countActive(with_({ minRating: 8 }))).toBe(1);
    expect(countActive(with_({ fromYear: 1990, toYear: 2000 }))).toBe(1);
    expect(countActive(with_({ minRating: 8, toYear: 2000, person: 'X' }))).toBe(3);
  });
});
