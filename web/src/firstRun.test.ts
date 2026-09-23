import { describe, expect, it } from 'vitest';
import { FIRST_RUN_POOL, firstRunFilms, SHELVES, TILE_TITLE_MAX, tileReveal, tilesFrom } from './firstRun';

/** A fixed source of randomness: the tests should not roll dice. */
function fixed(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe('the shelves', () => {
  it('has eight of them, none empty', () => {
    const shelves = Object.values(SHELVES);
    expect(shelves).toHaveLength(8);
    for (const shelf of shelves) expect(shelf.length).toBeGreaterThan(0);
  });

  it('never lists the same film twice', () => {
    const ids = FIRST_RUN_POOL.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps every title short enough for the tile to show it whole', () => {
    // The tile is one line with an ellipsis, so a long title would make
    // the cold screen look different depending on the draw.
    for (const f of FIRST_RUN_POOL) {
      expect(f.title.length, f.title).toBeLessThanOrEqual(TILE_TITLE_MAX);
    }
  });

  it('gives every film an id, a year and a real poster path', () => {
    for (const f of FIRST_RUN_POOL) {
      expect(f.id).toBeGreaterThan(0);
      expect(f.year).toBe(Number(f.release_date.slice(0, 4)));
      expect(f.poster).toMatch(/^https:\/\/image\.tmdb\.org\/t\/p\/w342\/\w+\.jpg$/);
    }
  });
});

describe('tileReveal', () => {
  it('starts every tile toward the middle of the grid', () => {
    const mid = tileReveal(0, 4, 8);
    const centre = tileReveal(6, 4, 8);
    expect(mid.x).toBe('calc(1.5 * (100% + 12px))');
    expect(mid.y).toBe('calc(0.5 * (100% + 12px))');
    expect(centre.x).toBe('calc(-0.5 * (100% + 12px))');
    expect(centre.y).toBe('calc(-0.5 * (100% + 12px))');
    expect(centre.delay).toBeLessThan(mid.delay);
  });
});

describe('firstRunFilms', () => {
  it('offers one film from each shelf', () => {
    const picked = firstRunFilms(fixed([0]));
    expect(picked).toHaveLength(8);
    for (const shelf of Object.values(SHELVES)) {
      expect(picked.some((f) => shelf.some((s) => s.id === f.id))).toBe(true);
    }
  });

  it('never repeats a film within one set', () => {
    for (let i = 0; i < 200; i++) {
      const ids = firstRunFilms().map((f) => f.id);
      expect(new Set(ids).size).toBe(8);
    }
  });

  it('gives a different set on another roll', () => {
    const a = firstRunFilms(fixed([0])).map((f) => f.id).sort();
    const b = firstRunFilms(fixed([0.99])).map((f) => f.id).sort();
    expect(a).not.toEqual(b);
  });

  it('reaches every film on the shelves over many rolls', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 4000; i++) for (const f of firstRunFilms()) seen.add(f.id);
    expect(seen.size).toBe(FIRST_RUN_POOL.length);
  });

  it('stays inside the shelf when the roll returns 1', () => {
    // Math.random() is [0,1), but a caller's source may not be.
    expect(() => firstRunFilms(fixed([1]))).not.toThrow();
    expect(firstRunFilms(fixed([1])).filter(Boolean)).toHaveLength(8);
  });
});

describe('tilesFrom', () => {
  const hit = (id: number, title: string, year = 1999, poster = 'https://image.tmdb.org/t/p/w342/a.jpg') =>
    ({ id, title, year, poster });

  it('turns the API answer into tiles', () => {
    const hits = Array.from({ length: 8 }, (_, i) => hit(i + 1, `Film ${i}`, 1960 + i * 8));
    const tiles = tilesFrom(hits);
    expect(tiles).toHaveLength(8);
    expect(tiles[0]).toMatchObject({ id: 1, title: 'Film 0', year: 1960, release_date: '1960' });
  });

  it('drops anything a tile cannot show', () => {
    const hits = [
      hit(1, 'Fine'),
      hit(2, 'No poster at all', 1999, ''),
      { id: 3, title: 'No year', year: 0, poster: 'https://image.tmdb.org/t/p/w342/c.jpg' },
      hit(4, 'A title far too long to fit on one line of a tile'),
    ];
    expect(tilesFrom(hits, 1).map((t) => t.title)).toEqual(['Fine']);
  });

  it('never repeats a film', () => {
    const hits = [hit(1, 'One'), hit(1, 'One'), hit(2, 'Two')];
    expect(tilesFrom(hits, 2).map((t) => t.id)).toEqual([1, 2]);
  });

  it('refuses a thin answer whole, so the built-in set is used instead', () => {
    expect(tilesFrom([hit(1, 'Only one')], 8)).toEqual([]);
    expect(tilesFrom([], 8)).toEqual([]);
  });
});
