import { describe, expect, it } from 'vitest';
import { roleLine, versus } from './GridSheet';
import type { GridFilm, GridPerson } from './grid';

const anchor: GridFilm = { id: 'nm0000001', title: 'The Matrix', year: 1999, rating: 8.7, md: 0, people: [], isAnchor: true };
const film = (rating: number | null, over: Partial<GridFilm> = {}): GridFilm => ({
  id: 'nm0000002', title: 'Bound', year: 1996, rating, md: 0, people: [], isAnchor: false, ...over,
});

describe('versus', () => {
  it('says how far below the searched film a film sits', () => {
    expect(versus(film(7.3), anchor)).toEqual({ dir: 'down', delta: -1.4, title: 'The Matrix' });
  });

  it('says how far above', () => {
    expect(versus(film(9.1), anchor)).toEqual({ dir: 'up', delta: 0.4, title: 'The Matrix' });
  });

  it('says the same when they match to a tenth', () => {
    expect(versus(film(8.7), anchor)).toEqual({ dir: 'same', delta: 0, title: 'The Matrix' });
    expect(versus(film(8.72), anchor)).toEqual({ dir: 'same', delta: 0, title: 'The Matrix' });
  });

  it('says nothing for the searched film or an unrated one', () => {
    expect(versus(film(8, { isAnchor: true }), anchor)).toBeNull();
    expect(versus(film(null), anchor)).toBeNull();
    expect(versus(film(7), { ...anchor, rating: null })).toBeNull();
  });
});

describe('roleLine', () => {
  const cast: GridPerson = { id: 'nm0000001', name: 'Keanu Reeves', role: 'cast', character: 'Neo', order: 0 };
  const helm: GridPerson = { id: 'nm0000002', name: 'Lana Wachowski', role: 'director', order: -1 };

  it('names the character for cast', () => {
    expect(roleLine(cast, 'The Matrix')).toBe('Neo in The Matrix');
  });

  it('says directed for a director', () => {
    expect(roleLine(helm, 'The Matrix')).toBe('Directed The Matrix');
  });

  it('copes with a missing character', () => {
    expect(roleLine({ ...cast, character: undefined }, 'The Matrix')).toBe('In The Matrix');
  });
});
