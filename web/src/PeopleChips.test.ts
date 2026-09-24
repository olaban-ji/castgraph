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
    const counts = filmCounts([{ people: ['nm0000001', 'nm0000002'] }, { people: ['nm0000002'] }, { people: [] }]);
    expect(counts.get('nm0000001')).toBe(1);
    expect(counts.get('nm0000002')).toBe(2);
    expect(counts.get('nm0000009')).toBeUndefined();
  });

  it('counts a person once per film, however many credits they have', () => {
    const counts = filmCounts([{ people: ['nm0000001', 'nm0000001', 'nm0000002'] }, { people: ['nm0000001'] }]);
    expect(counts.get('nm0000001')).toBe(2);
    expect(counts.get('nm0000002')).toBe(1);
  });

  it('is not what the chips use: the chips show no number at all', () => {
    // The count came off the chips in the design pass, and the catalog
    // does not send one. What the grid needs from a person is who they
    // are, not how many films they were in.
    expect(real.people.every((p) => typeof p.id === 'string' && p.id.startsWith('nm'))).toBe(true);
  });
});
