import { describe, expect, it } from 'vitest';
import { POSTER_MISS_MS, colourFor, posterAttempts, posterURL, sheetPosterURL } from './poster';

describe('posterURL', () => {
  const raw = 'https://m.media-amazon.com/images/M/MV5BABC@@._V1_SX300.jpg';

  it('asks Amazon for about the width the card draws', () => {
    // A 92px card at 2x wants 184, so the 185 rung.
    expect(posterURL(raw, 92, 2)).toBe('https://m.media-amazon.com/images/M/MV5BABC@@._SX185_.jpg');
    expect(posterURL(raw, 46, 1)).toBe('https://m.media-amazon.com/images/M/MV5BABC@@._SX92_.jpg');
  });

  it('does not chase a screen denser than two', () => {
    expect(posterURL(raw, 92, 4)).toBe(posterURL(raw, 92, 2));
  });

  it('tops out rather than asking for something absurd', () => {
    expect(posterURL(raw, 4000, 2)).toBe('https://m.media-amazon.com/images/M/MV5BABC@@._SX780_.jpg');
  });

  it('leaves a host it does not know alone', () => {
    const other = 'https://example.test/poster.jpg';
    expect(posterURL(other, 92)).toBe(other);
  });

  it('asks for the panel size, which is a step larger than the card', () => {
    const card = posterURL(raw, 52, 2);
    const panel = sheetPosterURL(raw);
    expect(panel).toBe('https://m.media-amazon.com/images/M/MV5BABC@@._SX185_.jpg');
    expect(panel).not.toBe(card);
  });

  it('is nothing when there is no poster', () => {
    expect(posterURL(undefined, 92)).toBeUndefined();
    expect(posterURL('', 92)).toBeUndefined();
  });
});

describe('posterAttempts', () => {
  const stored = 'https://m.media-amazon.com/images/M/abc@._V1_SX300.jpg';
  const resized = 'https://m.media-amazon.com/images/M/abc@._SX185_.jpg';

  it('tries the stored file immediately when the resize misses', () => {
    expect(posterAttempts(resized, stored)).toEqual([
      { url: resized, delayMs: 0 },
      { url: stored, delayMs: 0 },
      { url: `${stored}?r=1`, delayMs: POSTER_MISS_MS },
    ]);
  });

  it('waits out the edge when there is only one address', () => {
    expect(posterAttempts(stored, stored)).toEqual([
      { url: stored, delayMs: 0 },
      { url: `${stored}?r=1`, delayMs: POSTER_MISS_MS },
    ]);
  });

  it('is nothing when there is no poster', () => {
    expect(posterAttempts(undefined, undefined)).toEqual([]);
  });
});

describe('colourFor', () => {
  it('gives one film one colour, every time', () => {
    expect(colourFor('The Matrix')).toBe(colourFor('The Matrix'));
  });

  it('gives different films different ones', () => {
    expect(colourFor('The Matrix')).not.toBe(colourFor('Heat'));
  });

  it('is always a colour, even for an empty title', () => {
    expect(colourFor('')).toMatch(/^hsl\(/);
  });
});

describe('a TMDb poster', () => {
  const at = 'https://image.tmdb.org/t/p/w780/abc123.jpg';

  it('is asked for at the width it is drawn', () => {
    // The fallback stores w780 so the share card has something to
    // scale from; a 104px tile must not download that.
    expect(posterURL(at, 104)).toBe('https://image.tmdb.org/t/p/w342/abc123.jpg');
    expect(posterURL(at, 46)).toBe('https://image.tmdb.org/t/p/w92/abc123.jpg');
  });

  it('never asks for more than the host has', () => {
    expect(posterURL(at, 2000)).toBe('https://image.tmdb.org/t/p/w780/abc123.jpg');
  });

  it('leaves an address on a host it does not know alone', () => {
    expect(posterURL('https://example.com/p.jpg', 104)).toBe('https://example.com/p.jpg');
  });
});
