import { describe, expect, it } from 'vitest';
import { compactRating, creditLine, titleSize } from './Node';

describe('titleSize', () => {
  it('steps the anchor title down as it gets longer', () => {
    expect(titleSize('Parasite')).toBe(30);
    expect(titleSize('The Matrix')).toBe(24);
    expect(titleSize('The Shawshank Redemption')).toBe(19);
  });
});

describe('compactRating', () => {
  it('prefers IMDb when both ratings are present', () => {
    expect(compactRating({ imdb_rating: 8.9, rating: 8.2 })).toEqual({ value: 8.9, source: 'IMDb' });
  });
  it('falls back to TMDb', () => {
    expect(compactRating({ rating: 7.6 })).toEqual({ value: 7.6, source: 'TMDb' });
  });
  it('is null when neither rating is set', () => {
    expect(compactRating({})).toBeNull();
  });
});

describe('creditLine', () => {
  it('uses as for acting roles', () => {
    expect(creditLine('Keanu Reeves', 'Neo')).toBe('Keanu Reeves as Neo');
  });
  it('uses directed for directors', () => {
    expect(creditLine('Christopher Nolan', 'Director')).toBe('Christopher Nolan directed');
  });
  it('falls back to the name', () => {
    expect(creditLine('Unknown', '')).toBe('Unknown');
  });
});
