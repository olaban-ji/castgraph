import { describe, expect, it } from 'vitest';
import { filmCounts, toneOf } from './PeopleChips';
import matrix from './fixtures/matrix-grid.json';
import type { GridPayload } from './grid';

const real = matrix as GridPayload;

describe('toneOf', () => {
  it('gives cast and directors their own tone, and nothing else a colour', () => {
    expect(toneOf('cast')).toBe('var(--accent)');
    expect(toneOf('director')).toBe('var(--director)');
  });
});

describe('filmCounts', () => {
  it('counts the films each person is on', () => {
    const counts = filmCounts([{ people: [1, 2] }, { people: [2] }, { people: [] }]);
    expect(counts.get(1)).toBe(1);
    expect(counts.get(2)).toBe(2);
    expect(counts.get(9)).toBeUndefined();
  });

  it('counts a person once per film, however many credits they have', () => {
    const counts = filmCounts([{ people: [1, 1, 2] }, { people: [1] }]);
    expect(counts.get(1)).toBe(2);
    expect(counts.get(2)).toBe(1);
  });

  it('is not what the chips use: the server counts a whole career', () => {
    // The spine is only where the cards go, so there is nothing in it to
    // count from — `people[].count` is the number a chip shows.
    expect(real.people.every((p) => typeof p.count === 'number' && p.count > 0)).toBe(true);
  });
});
