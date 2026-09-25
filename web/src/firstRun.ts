import type { FirstRunHit, SearchHit } from './api';

/** The header's height, which the cold screen leaves room for. */
const HEADER_H = 64;

export type FirstRunFilm = SearchHit & { year: number; c?: string };

/** The most tiles the cold screen ever shows: one per era. A short
 *  window shows fewer, so the set still fits under the header. */
export const COLD_MAX = 8;

/** Columns in `.mc-tiles`: two below the phone breakpoint, four above. */
export function coldColumns(vw: number): number {
  return vw < 640 ? 2 : 4;
}

/** How many tiles fit in the window as whole rows. The block is centred
 *  under the header; more than this and the top row slides under the
 *  header while the bottom years are cut off. */
export function coldScreenCount(vw: number, vh: number): number {
  const columns = coldColumns(vw);
  const gap = 12;
  const pad = 24;
  const intro = 52;
  const gridMargin = 22;
  // The frame's 2:3 box plus the 31px block of title and year under
  // it, and the 4px between them.
  const caption = 35;
  const innerW = Math.min(Math.max(0, vw - pad * 2), 560);
  const tileW = (innerW - gap * (columns - 1)) / columns;
  const tileH = tileW * 1.5 + caption;
  const available = vh - HEADER_H - pad - intro - gridMargin;
  if (!(tileH > 0) || available <= 0) return columns;
  const rows = Math.max(1, Math.floor((available + gap) / (tileH + gap)));
  return Math.min(COLD_MAX, columns * rows);
}

/** Every film on the shelves, for anything that needs the whole set. */
/** The films the cold screen can actually show, out of what the API
 *  sent: one tile per film, each with a picture and a year.
 *
 *  A long title is kept and left to the ellipsis. It used to be dropped,
 *  because the forty-eight films were hand-picked to be short and an
 *  odd one out made the screen look wrong. The catalog picks them now,
 *  and "Indiana Jones and the Temple of Doom" is an ordinary answer —
 *  refusing it emptied the whole screen over one film. */
export function tilesFrom(hits: FirstRunHit[], want = 8): FirstRunFilm[] {
  const seen = new Set<string>();
  const out: FirstRunFilm[] = [];
  for (const h of hits) {
    if (!h.poster || !h.year || !h.title) continue;
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    out.push({
      id: h.id,
      title: h.title,
      year: h.year,
      release_date: String(h.year),
      poster: h.poster,
      c: h.c,
    });
  }
  return out.slice(0, want);
}

/** How long each tile waits behind the one before it once the list
 *  arrives, in reading order.
 *
 *  Small on purpose. This is no longer a tile appearing from nothing —
 *  the frame has been on screen since the shell painted — it is the
 *  colour and the words filling a box that is already there, so the
 *  stagger only has to keep the eight from landing as one block. */
export const TILE_STEP_MS = 40;


/** Posters asked for ahead of the rest. The first row is what a reader
 *  looks at first, and a browser given eight equal requests will not
 *  guess which. */
export const EAGER_TILES = 4;

