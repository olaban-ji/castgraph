import { describe, expect, it } from 'vitest';
import { colourFor, posterURL, sheetPosterURL } from './poster';

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
