import { describe, expect, it } from 'vitest';
import { POSTER_MISS_MS, hueOf, posterAttempts, posterFallback, posterURL, sheetPosterURL } from './poster';

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

describe('posterFallback', () => {
  it('gives one film one fill, every time', () => {
    expect(posterFallback('The Matrix')).toBe(posterFallback('The Matrix'));
  });

  it('gives different films different ones', () => {
    expect(posterFallback('The Matrix')).not.toBe(posterFallback('Heat'));
  });

  it('is always a fill, even for an empty title', () => {
    // A gradient now, not the flat hsl() tint it used to be: the design
    // draws a posterless frame as a 165° OKLCH gradient in the film's hue.
    expect(posterFallback('')).toMatch(/^linear-gradient\(165deg, oklch\(/);
  });
});

describe('hueOf', () => {
  it('is the hash the design and the share card use', () => {
    // Worked out with the design prototype's own hueOf, which is this
    // loop; cmd/api/og.go has to land on the same numbers.
    expect(hueOf('The Matrix')).toBe(24);
    expect(hueOf('Memento')).toBe(289);
    expect(hueOf('Heat')).toBe(176);
  });

  it('is zero for an empty title, never NaN', () => {
    expect(hueOf('')).toBe(0);
  });

  it('hashes UTF-16 code units, so accents, CJK and emoji are stable', () => {
    expect(hueOf('Amélie')).toBe(331);
    expect(hueOf('千と千尋の神隠し')).toBe(156);
    // The emoji is a surrogate pair, and both halves are hashed.
    expect(hueOf('😀 Emoji')).toBe(353);
  });

  it('stays on the colour wheel for a title long enough to wrap the hash', () => {
    const h = hueOf('Dr. Strangelove or: How I Learned to Stop Worrying and Love the Bomb');
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
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
