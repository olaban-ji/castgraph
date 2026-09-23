import { describe, expect, it } from 'vitest';
import { bloomShift, compactRating, connectionLabel, exploreLabel, placeStyle, sizedTmdbUrl, titleSize } from './Node';
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

  it('shifts a card back onto the anchor so the reveal can glide it out', () => {
    const other = { ...film, anchor: false, x: 700, y: 800, w: 160, h: 100 };
    expect(bloomShift(other, film, g.stem, 1)).toEqual({ x: -320, y: -330 });
    expect(bloomShift(other, film, g.stem, 0.5)).toEqual({ x: -160, y: -165 });
  });
});

describe('connectionLabel', () => {
  it('names the person and what they did — the question the map exists to answer', () => {
    expect(connectionLabel({ relation: 'Keanu Reeves', role: 'Neo', anchor: false }))
      .toBe('Keanu Reeves · Neo');
  });

  it('says directed rather than naming a character', () => {
    expect(connectionLabel({ relation: 'Bong Joon Ho', role: 'Director', anchor: false }))
      .toBe('Bong Joon Ho · directed');
  });

  it('falls back to the person alone when the role is unknown', () => {
    expect(connectionLabel({ relation: 'Tilda Swinton', role: '', anchor: false }))
      .toBe('Tilda Swinton');
  });

  it('is empty for the searched film, which hangs from nothing', () => {
    expect(connectionLabel({ relation: 'Keanu Reeves', role: 'Neo', anchor: true })).toBe('');
  });
});

describe('placeStyle', () => {
  it('covers the pin as well as the card so the whole node is one target', () => {
    const g = GEOMETRY.desktop;
    const film = {
      id: 'm:1', x: 500, y: 400, w: g.trunk[0], h: g.trunk[1], tier: 'trunk' as const,
      movie: { id: 'm:1', type: 'movie' as const, label: 'X', tmdb_id: 1 },
      year: 1999, trunk: true, anchor: false, side: 1 as const,
      relation: '', relationPersonId: '', role: '', billing: 1, depth: 1,
    };
    const style = placeStyle(film, g, 1);
    expect(style.height).toBe(g.trunk[1] + g.stem);
  });
});

describe('exploreLabel', () => {
  it('says what it does when the card has room', () => {
    expect(exploreLabel(260, 12)).toBe('Explore from here →');
  });

  it('shortens rather than running off a narrow card', () => {
    // A 180px branch card with counter-scaled 19px text: the long label
    // would need ~200px and be clipped.
    expect(exploreLabel(180, 19)).toBe('Explore →');
  });

  it('falls back to the arrow alone when nothing else fits', () => {
    expect(exploreLabel(110, 19)).toBe('→');
  });

  it('never returns a label wider than the card', () => {
    for (const [w, size] of [[110, 19], [144, 14], [180, 19], [260, 12], [340, 12]] as const) {
      expect(exploreLabel(w, size).length * size * 0.55).toBeLessThanOrEqual(w - 36 + 0.01);
    }
  });
});
