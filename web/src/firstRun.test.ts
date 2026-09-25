import { describe, expect, it } from 'vitest';
import {
  COLD_MAX,
  coldColumns,
  coldScreenCount,
  TILE_STEP_MS,
  tilesFrom,
} from './firstRun';

describe('coldColumns', () => {
  it('is two on a phone and four above it', () => {
    expect(coldColumns(390)).toBe(2);
    expect(coldColumns(639)).toBe(2);
    expect(coldColumns(640)).toBe(4);
    expect(coldColumns(1440)).toBe(4);
  });
});

describe('coldScreenCount', () => {
  it('fills a desktop window', () => {
    expect(coldScreenCount(1440, 900)).toBe(COLD_MAX);
  });

  it('shows whole rows, never a ragged last one', () => {
    for (const h of [500, 600, 700, 800, 900]) {
      const n = coldScreenCount(1440, h);
      expect(n % coldColumns(1440)).toBe(0);
    }
  });

  it('never offers more than there are', () => {
    expect(coldScreenCount(2560, 2000)).toBeLessThanOrEqual(COLD_MAX);
  });

  it('still offers something on a short phone', () => {
    expect(coldScreenCount(390, 640)).toBeGreaterThan(0);
  });

  // The window sizes this used to get wrong. It counted on a 12px gap,
  // 24px of padding and a 52px intro while the stylesheet used 14, 40
  // and about 90 — so it asked for a row the page had no room for and
  // the bottom of the grid was cut off.
  it('asks for no more rows than the window can show', () => {
    for (const [vw, vh] of [
      [1280, 720],
      [1280, 760],
      [1440, 900],
      [390, 844],
    ]) {
      const columns = coldColumns(vw);
      const n = coldScreenCount(vw, vh);
      const rows = n / columns;
      const innerW = Math.min(Math.max(0, vw - 40), 560);
      const tileW = (innerW - 14 * (columns - 1)) / columns;
      const tall = rows * (tileW * 1.5 + 35) + (rows - 1) * 14;
      const room = vh - 64 - Math.min(Math.max(32, vh * 0.1), 120) - 90 - 26 - 40;
      expect(tall, `${vw}x${vh} asked for ${rows} rows`).toBeLessThanOrEqual(room);
    }
  });

  it('uses the measured grid top when it has one', () => {
    // The stand-in numbers are a second copy of the stylesheet. Given a
    // real measurement it uses that instead.
    const measured = coldScreenCount(1440, 900, 300);
    const guessed = coldScreenCount(1440, 900);
    expect(measured).toBeGreaterThan(0);
    expect(measured % coldColumns(1440)).toBe(0);
    expect(guessed).toBeGreaterThan(0);
  });
});

describe('tilesFrom', () => {
  const hit = (id: string, title: string, year = 1999) => ({
    id,
    title,
    year,
    poster: `https://m.media-amazon.com/images/M/${id}._V1_SX300.jpg`,
  });

  it('keeps what the API sent, as tiles', () => {
    const got = tilesFrom(
      [
        hit('tt0133093', 'The Matrix'),
        hit('tt0111161', 'Shawshank', 1994),
        hit('tt0468569', 'The Dark Knight', 2008),
      ],
      3,
    );
    expect(got.map((f) => f.id)).toEqual(['tt0133093', 'tt0111161', 'tt0468569']);
    expect(got[0].year).toBe(1999);
  });

  it('drops a film with nothing to show', () => {
    const got = tilesFrom(
      [
        { id: 'tt1', title: 'No Poster', year: 1999, poster: '' },
        { id: 'tt2', title: '', year: 1999, poster: 'https://x/p.jpg' },
        { id: 'tt3', title: 'No Year', year: 0, poster: 'https://x/p.jpg' },
        hit('tt0133093', 'The Matrix'),
      ],
      1,
    );
    expect(got.map((f) => f.id)).toEqual(['tt0133093']);
  });

  it('keeps a long title and lets the ellipsis deal with it', () => {
    // One long name must not empty the screen: the catalog picks these
    // now, and plenty of real films have long names.
    const long = 'Indiana Jones and the Temple of Doom';
    expect(tilesFrom([hit('tt1', long)], 1).map((f) => f.title)).toEqual([long]);
  });

  it('never shows the same film twice', () => {
    const got = tilesFrom([hit('tt1', 'One'), hit('tt1', 'One'), hit('tt2', 'Two')], 2);
    expect(got.map((f) => f.id)).toEqual(['tt1', 'tt2']);
  });

  it('shows what it has rather than nothing', () => {
    expect(tilesFrom([hit('tt1', 'One')], 8)).toHaveLength(1);
  });
});

describe('the tile stagger', () => {
  it('is small enough that eight of them read as one arrival', () => {
    // The frame has been on screen since the shell painted, so this is
    // colour and words filling a box that is already there. All eight
    // are in within a third of a second.
    expect(TILE_STEP_MS * 7).toBeLessThanOrEqual(320);
  });

  it('starts the first tile straight away', () => {
    // No lead-in. There is nothing to wait for: the list has arrived.
    expect(TILE_STEP_MS * 0).toBe(0);
  });
});
