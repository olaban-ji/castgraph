import { describe, expect, it } from 'vitest';
import { chipName, filmCounts } from './PeopleChips';
import matrix from './fixtures/matrix-grid.json';
import type { GridPayload, GridPerson, SpineTuple } from './grid';

const real = matrix as GridPayload;

const person = (id: string, order: number): GridPerson => ({ id, name: id, role: 'cast', order });

describe('filmCounts', () => {
  // The refresh puts a count back on every chip: how many of that
  // person's films this map holds. It came off in an earlier design pass
  // ("the map is open-ended"); the handoff brings it back on purpose, as
  // a way to see whose work the map is mostly made of. It is read off
  // the spine the map already has, so it needs nothing new from the API.
  const people = [person('nm0000001', 0), person('nm0000002', 1), person('nm0000003', 2)];

  it('counts the films each person is on, the searched film included', () => {
    const films: SpineTuple[] = [
      ['tt0000001', 1999, 8.7, 331, [0, 1, 2]],
      ['tt0000002', 2003, 7.2, 515, [1]],
      ['tt0000003', 2005, null, 0, [1, 2]],
      ['tt0000004', 2010, 6.1, 0, []],
    ];
    const counts = filmCounts({ people, films });
    expect(counts.get('nm0000001')).toBe(1);
    expect(counts.get('nm0000002')).toBe(3);
    // Unrated films are theirs too: the count is the map's, not what
    // the filters have left lit.
    expect(counts.get('nm0000003')).toBe(2);
    expect(counts.get('nm0000009')).toBeUndefined();
  });

  it('counts a person once per film, however many credits they have', () => {
    const films: SpineTuple[] = [
      ['tt0000001', 1999, 8.7, 331, [0, 0, 1]],
      ['tt0000002', 2003, 7.2, 515, [0]],
    ];
    const counts = filmCounts({ people, films });
    expect(counts.get('nm0000001')).toBe(2);
    expect(counts.get('nm0000002')).toBe(1);
  });

  it('ignores a place in the row that names nobody', () => {
    const counts = filmCounts({ people, films: [['tt0000001', 1999, 8.7, 331, [0, 7]]] });
    expect([...counts]).toEqual([['nm0000001', 1]]);
  });

  it('gives no counts at all for a spine that does not say who is on each film', () => {
    // The fixture is such a spine. A chip then shows its name alone,
    // rather than a zero that would be a claim the map cannot make.
    expect(real.films.every((f) => f[4] === undefined)).toBe(true);
    expect(filmCounts(real).size).toBe(0);
  });
});

describe('chipName', () => {
  it('says the count as words after the name', () => {
    expect(chipName('Keanu Reeves', 41)).toBe('Keanu Reeves, 41 movies');
    expect(chipName('Gloria Foster', 1)).toBe('Gloria Foster, 1 movie');
  });

  it('leaves a chip with no count to its own text', () => {
    expect(chipName('Keanu Reeves', undefined)).toBeUndefined();
  });
});
