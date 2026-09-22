import { describe, expect, it } from 'vitest';
import type { Pathways } from './api';
import { filterPathways, provisionalPathways } from './tree';

const film = (id: number, role: string) => ({
  id: `m:${id}`, type: 'movie' as const, label: `f${id}`, tmdb_id: id,
  year: 2000, votes: 900, role, order: 1,
});

function pathways(): Pathways {
  return {
    movie: { id: 'm:1', type: 'movie', label: 'Seed', tmdb_id: 1, year: 1999 },
    cast: [
      { person: { id: 'p:1', type: 'person', label: 'Actor', tmdb_id: 1 }, role: 'Neo', order: 0, films: [film(10, 'Jack'), film(11, 'Director')] },
      { person: { id: 'p:2', type: 'person', label: 'Helmer', tmdb_id: 2 }, role: 'Director', order: 0, films: [film(12, 'Director')] },
    ],
  };
}

describe('filterPathways', () => {
  it('is the same object when both relation types are wanted', () => {
    const pw = pathways();
    expect(filterPathways(pw, { cast: true, director: true })).toBe(pw);
  });

  it('drops directing hops when the director chip is off', () => {
    const out = filterPathways(pathways(), { cast: true, director: false });
    expect(out.cast.map((c) => c.person.id)).toEqual(['p:1']);
    expect(out.cast[0].films.map((f) => f.tmdb_id)).toEqual([10]);
  });

  it('drops acting hops when the cast chip is off, keeping the director', () => {
    const out = filterPathways(pathways(), { cast: false, director: true });
    expect(out.cast.map((c) => c.person.id)).toEqual(['p:1', 'p:2']);
    expect(out.cast[0].films.map((f) => f.tmdb_id)).toEqual([11]);
    expect(out.cast[1].films.map((f) => f.tmdb_id)).toEqual([12]);
  });

  it('turning both off leaves nothing to grow from', () => {
    expect(filterPathways(pathways(), { cast: false, director: false }).cast).toEqual([]);
  });

  it('never mutates the response it was given', () => {
    const pw = pathways();
    filterPathways(pw, { cast: true, director: false });
    expect(pw.cast[0].films).toHaveLength(2);
  });
});

describe('provisionalPathways', () => {
  it('is a one-film map from what the search result already told us', () => {
    const movie = { id: 'm:603', type: 'movie' as const, label: 'The Matrix', tmdb_id: 603, year: 1999 };
    expect(provisionalPathways(movie)).toEqual({ movie, cast: [] });
  });
});
