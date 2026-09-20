import { describe, expect, it } from 'vitest';
import { movieIdFrom, movieIdFromState, urlWithoutMovie } from './movieParam';

describe('movieIdFrom', () => {
  it('accepts a positive integer', () => {
    expect(movieIdFrom('33364')).toBe(33364);
  });

  it('rejects missing or invalid values', () => {
    expect(movieIdFrom(null)).toBeNull();
    expect(movieIdFrom('')).toBeNull();
    expect(movieIdFrom('0')).toBeNull();
    expect(movieIdFrom('-1')).toBeNull();
    expect(movieIdFrom('3.5')).toBeNull();
    expect(movieIdFrom('abc')).toBeNull();
  });
});

describe('movieIdFromState', () => {
  it('reads a movie id from history.state', () => {
    expect(movieIdFromState({ movie: 603 })).toBe(603);
  });

  it('ignores anything else', () => {
    expect(movieIdFromState(null)).toBeNull();
    expect(movieIdFromState({ movie: '603' })).toBeNull();
    expect(movieIdFromState({})).toBeNull();
  });
});

describe('urlWithoutMovie', () => {
  it('strips ?movie= and leaves a bare path', () => {
    expect(urlWithoutMovie('https://cinedikt.fly.dev/?movie=33364')).toBe('/');
  });

  it('keeps other query params and the hash', () => {
    expect(
      urlWithoutMovie('https://cinedikt.fly.dev/?device=phone&movie=603#x'),
    ).toBe('/?device=phone#x');
  });
});
