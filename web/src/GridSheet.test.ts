import { describe, expect, it } from 'vitest';
import { roleLine, versus } from './GridSheet';
import type { GridFilm, GridPerson } from './grid';

const anchor: GridFilm = { id: 1, title: 'The Matrix', year: 1999, rating: 8.7, people: [], isAnchor: true };
const film = (rating: number | null, over: Partial<GridFilm> = {}): GridFilm => ({
  id: 2, title: 'Bound', year: 1996, rating, people: [], isAnchor: false, ...over,
});

describe('versus', () => {
  it('says how far below the searched film a film sits', () => {
    expect(versus(film(7.3), anchor)).toBe('1.4 below The Matrix');
  });

  it('says how far above', () => {
    expect(versus(film(9.1), anchor)).toBe('0.4 above The Matrix');
  });

  it('says the same when they match to a tenth', () => {
    expect(versus(film(8.7), anchor)).toBe('Same as The Matrix');
    expect(versus(film(8.72), anchor)).toBe('Same as The Matrix');
  });

  it('says nothing for the searched film or an unrated one', () => {
    expect(versus(film(8, { isAnchor: true }), anchor)).toBe('');
    expect(versus(film(null), anchor)).toBe('');
    expect(versus(film(7), { ...anchor, rating: null })).toBe('');
  });
});

describe('roleLine', () => {
  const cast: GridPerson = { id: 1, name: 'Keanu Reeves', role: 'cast', character: 'Neo', order: 0 };
  const helm: GridPerson = { id: 2, name: 'Lana Wachowski', role: 'director', order: -1 };

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
