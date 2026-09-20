import { describe, expect, it } from 'vitest';
import { compactRating, creditLine, placeStyle, sizedTmdbUrl, titleSize } from './Node';
import { GEOMETRY } from './layout';

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

describe('sizedTmdbUrl', () => {
  const poster = 'https://image.tmdb.org/t/p/w342/p96dm7sCMn4VYAStA6siNz30G1r.jpg';
  const backdrop = 'https://image.tmdb.org/t/p/w780/9BBTo63ANSmhC4e6r62OJFuK6L.jpg';

  it('picks the smallest bucket that covers the css size at dpr', () => {
    expect(sizedTmdbUrl(poster, 110, 2)).toBe(poster); // 220 px → w342
    expect(sizedTmdbUrl(poster, 80, 2)).toBe(poster.replace('w342', 'w185'));
    expect(sizedTmdbUrl(backdrop, 180, 2)).toBe(backdrop.replace('w780', 'w500'));
  });

  it('caps dpr at 2 so a 3× phone does not decode a w780 for a small card', () => {
    expect(sizedTmdbUrl(backdrop, 110, 3)).toBe(backdrop.replace('w780', 'w342'));
  });

  it('passes through missing and non-TMDb urls', () => {
    expect(sizedTmdbUrl(undefined, 110)).toBeUndefined();
    expect(sizedTmdbUrl('/local.png', 110)).toBe('/local.png');
  });
});

describe('placeStyle', () => {
  const g = GEOMETRY.phone;
  const film = {
    id: 'm:1', year: 1999, trunk: true, anchor: true, side: 1 as const, relation: '', relationPersonId: '',
    role: '', billing: 1, depth: 0, movie: { id: 'm:1', type: 'movie' as const, label: 'X', tmdb_id: 1, year: 1999 },
    x: 400, y: 500, w: 200, h: 130, tier: 'anchor' as const,
  };

  it('places the card in page pixels and only scales when zoomed', () => {
    const one = placeStyle(film, g, 1);
    expect(one.left).toBe(300);
    expect(one.top).toBe(500 - 22 - 130);
    expect(one.transform).toBeUndefined();
    const half = placeStyle(film, g, 0.5);
    expect(half.left).toBe(150);
    expect(half.top).toBe((500 - 22 - 130) * 0.5);
    expect(half.transform).toBe('scale(0.5)');
  });
});
