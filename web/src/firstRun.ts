import type { FirstRunHit, SearchHit } from './api';
import { HEADER_H } from './layout';

const POSTER_BASE = 'https://image.tmdb.org/t/p/w342';

export type FirstRunFilm = SearchHit & { year: number };

/** The cold screen offers eight one-tap entries. They are drawn from these
 *  shelves rather than from one flat list: eight films picked at random
 *  out of forty-eight could all be nineties American thrillers, and the
 *  point of the screen is to show how far apart two films can be and still
 *  be two films apart. One from each shelf, every time.
 *
 *  Ids and poster paths were resolved through the search endpoint, so they
 *  are TMDb's own and not guesses. Titles are kept to TILE_TITLE_MAX
 *  characters: the tile is 123px at desktop and `.mc-tile-title` is one
 *  line, so a longer title would be cut with an ellipsis and the screen
 *  would look different depending on which films came up. */
export const SHELVES: Record<string, FirstRunFilm[]> = {
  // Speculative
  speculative: [
    { id: 603, title: 'The Matrix', year: 1999, release_date: '1999-03-31', poster: `${POSTER_BASE}/dXNAPwY7VrqMAo51EKhhCJfaGb5.jpg` },
    { id: 78, title: 'Blade Runner', year: 1982, release_date: '1982-06-25', poster: `${POSTER_BASE}/63N9uy8nd9j7Eog2axPQ8lbr3Wj.jpg` },
    { id: 329865, title: 'Arrival', year: 2016, release_date: '2016-11-10', poster: `${POSTER_BASE}/pEzNVQfdzYDzVK0XqxERIw2x2se.jpg` },
    { id: 348, title: 'Alien', year: 1979, release_date: '1979-05-25', poster: `${POSTER_BASE}/vfrQk5IPloGg1v9Rzbh2Eg3VGyM.jpg` },
    { id: 9693, title: 'Children of Men', year: 2006, release_date: '2006-09-22', poster: `${POSTER_BASE}/k9IAS4TehZFcKi4HVByxZNPfqex.jpg` },
    { id: 1398, title: 'Stalker', year: 1979, release_date: '1979-05-25', poster: `${POSTER_BASE}/1qhOyf5C4s9ZdvY8d5JDx9DFMeT.jpg` },
  ],
  // Crime and consequence
  crime: [
    { id: 238, title: 'The Godfather', year: 1972, release_date: '1972-03-14', poster: `${POSTER_BASE}/3bhkrj58Vtu7enYsRolD1fZdja1.jpg` },
    { id: 680, title: 'Pulp Fiction', year: 1994, release_date: '1994-09-10', poster: `${POSTER_BASE}/vQWk5YBFWF4bZaofAbv0tShwBvQ.jpg` },
    { id: 769, title: 'GoodFellas', year: 1990, release_date: '1990-09-12', poster: `${POSTER_BASE}/9OkCLM73MIU2CrKZbqiT8Ln1wY2.jpg` },
    { id: 949, title: 'Heat', year: 1995, release_date: '1995-12-15', poster: `${POSTER_BASE}/umSVjVdbVwtx5ryCA2QXL44Durm.jpg` },
    { id: 598, title: 'City of God', year: 2002, release_date: '2002-08-30', poster: `${POSTER_BASE}/k7eYdWvhYQyRQoU2TB2A2Xu2TfD.jpg` },
    { id: 275, title: 'Fargo', year: 1996, release_date: '1996-03-08', poster: `${POSTER_BASE}/rt7cpEr1uP6RTZykBFhBTcRaKvG.jpg` },
  ],
  // Animation
  animation: [
    { id: 129, title: 'Spirited Away', year: 2001, release_date: '2001-07-20', poster: `${POSTER_BASE}/39wmItIWsg5sZMyRUHLkWBcuVCM.jpg` },
    { id: 8392, title: 'My Neighbor Totoro', year: 1988, release_date: '1988-04-16', poster: `${POSTER_BASE}/rtGDOeG9LzoerkDGZF9dnVeLppL.jpg` },
    { id: 2011, title: 'Persepolis', year: 2007, release_date: '2007-06-27', poster: `${POSTER_BASE}/aU8i2QAdTyRR1nYb36Gq51xXP8p.jpg` },
    { id: 9806, title: 'The Incredibles', year: 2004, release_date: '2004-10-27', poster: `${POSTER_BASE}/2LqaLgk4Z226KkgPJuiOQ58wvrm.jpg` },
    { id: 12477, title: 'Grave of the Fireflies', year: 1988, release_date: '1988-04-16', poster: `${POSTER_BASE}/k9tv1rXZbOhH7eiCk378x61kNQ1.jpg` },
    { id: 149, title: 'Akira', year: 1988, release_date: '1988-07-16', poster: `${POSTER_BASE}/neZ0ykEsPqxamsX6o5QNUFILQrz.jpg` },
  ],
  // Made outside Hollywood
  world: [
    { id: 843, title: 'In the Mood for Love', year: 2000, release_date: '2000-09-29', poster: `${POSTER_BASE}/8BgGbbWiLNhPtkMkN0gGTnbtvBv.jpg` },
    { id: 496243, title: 'Parasite', year: 2019, release_date: '2019-05-30', poster: `${POSTER_BASE}/7IiTTgloJzvGI1TAYymCfbfl3vT.jpg` },
    { id: 346, title: 'Seven Samurai', year: 1954, release_date: '1954-04-26', poster: `${POSTER_BASE}/lOMGc8bnSwQhS4XyE1S99uH8NXf.jpg` },
    { id: 60243, title: 'A Separation', year: 2011, release_date: '2011-02-15', poster: `${POSTER_BASE}/xQadpnoLokxzN3hRpCPbBGpxsiz.jpg` },
    { id: 1391, title: 'Y Tu Mamá También', year: 2001, release_date: '2001-06-08', poster: `${POSTER_BASE}/aj3rqjab8jfc2fWmcS3H3c5qbur.jpg` },
    { id: 11216, title: 'Cinema Paradiso', year: 1988, release_date: '1988-11-17', poster: `${POSTER_BASE}/9JhfVOveaY00o8njQu2Xrp4YWud.jpg` },
  ],
  // Before 1960
  classic: [
    { id: 289, title: 'Casablanca', year: 1943, release_date: '1943-01-15', poster: `${POSTER_BASE}/lGCEKlJo2CnWydQj7aamY7s1S7Q.jpg` },
    { id: 872, title: 'Singin\' in the Rain', year: 1952, release_date: '1952-04-10', poster: `${POSTER_BASE}/671EPwBsHGHBk0cdOeZqmOK0XB3.jpg` },
    { id: 389, title: '12 Angry Men', year: 1957, release_date: '1957-04-10', poster: `${POSTER_BASE}/zhG3vKWyDRaZYoaww1UVAi29T9h.jpg` },
    { id: 567, title: 'Rear Window', year: 1954, release_date: '1954-08-01', poster: `${POSTER_BASE}/ILVF0eJxHMddjxeQhswFtpMtqx.jpg` },
    { id: 239, title: 'Some Like It Hot', year: 1959, release_date: '1959-03-19', poster: `${POSTER_BASE}/hVIKyTK13AvOGv7ICmJjK44DTzp.jpg` },
    { id: 1092, title: 'The Third Man', year: 1949, release_date: '1949-08-31', poster: `${POSTER_BASE}/vqnFHTx1phgTAsLfxZoejSbMVHA.jpg` },
  ],
  // This century, lately
  modern: [
    { id: 376867, title: 'Moonlight', year: 2016, release_date: '2016-10-21', poster: `${POSTER_BASE}/qLnfEmPrDjJfPyyddLJPkXmshkp.jpg` },
    { id: 76341, title: 'Mad Max: Fury Road', year: 2015, release_date: '2015-05-13', poster: `${POSTER_BASE}/ulcAi4dKpAjHwYGS08vNyx9H6I9.jpg` },
    { id: 244786, title: 'Whiplash', year: 2014, release_date: '2014-10-10', poster: `${POSTER_BASE}/7fn624j5lj3xTme2SgiLCeuedmO.jpg` },
    { id: 419430, title: 'Get Out', year: 2017, release_date: '2017-02-24', poster: `${POSTER_BASE}/tFXcEccSQMf3lfhfXKSU9iRBpa3.jpg` },
    { id: 426426, title: 'Roma', year: 2018, release_date: '2018-11-21', poster: `${POSTER_BASE}/dtIIyQyALk57ko5bjac7hi01YQ.jpg` },
    { id: 438631, title: 'Dune', year: 2021, release_date: '2021-09-15', poster: `${POSTER_BASE}/v1tRXZ4JtD2Iv6fjkPvT4GiwslV.jpg` },
  ],
  // Funny and warm
  comedy: [
    { id: 194, title: 'Amélie', year: 2001, release_date: '2001-04-25', poster: `${POSTER_BASE}/nSxDa3M9aMvGVLoItzWTepQ5h5d.jpg` },
    { id: 76, title: 'Before Sunrise', year: 1995, release_date: '1995-01-27', poster: `${POSTER_BASE}/kf1Jb1c2JAOqjuzA3H4oDM263uB.jpg` },
    { id: 137, title: 'Groundhog Day', year: 1993, release_date: '1993-02-11', poster: `${POSTER_BASE}/gCgt1WARPZaXnq523ySQEUKinCs.jpg` },
    { id: 115, title: 'The Big Lebowski', year: 1998, release_date: '1998-03-06', poster: `${POSTER_BASE}/3bv6WAp6BSxxYvB5ozKFUYuRA8C.jpg` },
    { id: 773, title: 'Little Miss Sunshine', year: 2006, release_date: '2006-07-26', poster: `${POSTER_BASE}/niNdhTpPHSgw22tK0PLjQMV640v.jpg` },
    { id: 346648, title: 'Paddington 2', year: 2017, release_date: '2017-11-05', poster: `${POSTER_BASE}/1OJ9vkD5xPt3skC6KguyXAgagRZ.jpg` },
  ],
  // Big screens
  blockbuster: [
    { id: 155, title: 'The Dark Knight', year: 2008, release_date: '2008-07-16', poster: `${POSTER_BASE}/qJ2tW6WMUDux911r6m7haRef0WH.jpg` },
    { id: 329, title: 'Jurassic Park', year: 1993, release_date: '1993-06-11', poster: `${POSTER_BASE}/d9mtMGQDLANKieb9PbD3yK7xxzo.jpg` },
    { id: 105, title: 'Back to the Future', year: 1985, release_date: '1985-07-03', poster: `${POSTER_BASE}/vN5B5WgYscRGcQpVhHl6p9DDTP0.jpg` },
    { id: 11, title: 'Star Wars', year: 1977, release_date: '1977-05-25', poster: `${POSTER_BASE}/fai0rspsNeJCS69wHNjOdWxcI7P.jpg` },
    { id: 578, title: 'Jaws', year: 1975, release_date: '1975-06-20', poster: `${POSTER_BASE}/lxM6kqilAdpdhqUl2biYp5frUxE.jpg` },
    { id: 562, title: 'Die Hard', year: 1988, release_date: '1988-07-15', poster: `${POSTER_BASE}/7Bjd8kfmDSOzpmhySpEhkUyK2oH.jpg` },
  ],
};

/** The longest title the tile shows whole. Calibrated by measuring: at
 *  12px in a 123px tile, "Grave of the Fireflies" (22) is exactly the
 *  widest that fits and "In the Mood for Love" (20) sits just inside it. */
export const TILE_TITLE_MAX = 22;

/** The most the cold screen ever offers: one from each shelf. A short
 *  window shows fewer, so the set still fits under the header. */
export const COLD_MAX = Object.keys(SHELVES).length;

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
  const caption = 37;
  const innerW = Math.min(Math.max(0, vw - pad * 2), 560);
  const tileW = (innerW - gap * (columns - 1)) / columns;
  const tileH = tileW * 1.5 + caption;
  const available = vh - HEADER_H - pad - intro - gridMargin;
  if (!(tileH > 0) || available <= 0) return columns;
  const rows = Math.max(1, Math.floor((available + gap) / (tileH + gap)));
  return Math.min(COLD_MAX, columns * rows);
}

/** Every film on the shelves, for anything that needs the whole set. */
export const FIRST_RUN_POOL: FirstRunFilm[] = Object.values(SHELVES).flat();

/** Turns what the API offers into tiles, keeping only what a tile can
 *  show: a poster, a year, and a title short enough not to be cut. An
 *  answer with too few usable films is refused whole, so the reader gets
 *  the built-in set rather than a half-empty screen. */
export function tilesFrom(hits: FirstRunHit[], want = 8): FirstRunFilm[] {
  const seen = new Set<number>();
  const out: FirstRunFilm[] = [];
  for (const h of hits) {
    if (!h.poster || !h.year || !h.title) continue;
    if (h.title.length > TILE_TITLE_MAX || seen.has(h.id)) continue;
    seen.add(h.id);
    out.push({ id: h.id, title: h.title, year: h.year, release_date: String(h.year), poster: h.poster });
  }
  return out.length >= want ? out.slice(0, want) : [];
}

/** Where a tile begins, measured back toward the middle of the grid, so
 *  the eight glide out from one point instead of appearing in their
 *  slots. `x` and `y` are translations in the tile's own size; `delay`
 *  is a few milliseconds, longer for the tiles furthest from the middle,
 *  so the outer ones follow the inner ones out. */
export function tileReveal(
  index: number,
  columns: number,
  count: number,
): { x: string; y: string; delay: number } {
  const col = index % columns;
  const row = Math.floor(index / columns);
  const rows = Math.max(1, Math.ceil(count / columns));
  const dx = (columns - 1) / 2 - col;
  const dy = (rows - 1) / 2 - row;
  return {
    x: `calc(${dx} * (100% + 12px))`,
    y: `calc(${dy} * (100% + 12px))`,
    delay: Math.round(Math.hypot(dx, dy) * 36),
  };
}

/** Eight entries, one from each shelf, in a shuffled order. `pick` is the
 *  source of randomness — the tests pass a fixed one. */
export function firstRunFilms(pick: () => number = Math.random): FirstRunFilm[] {
  const chosen = Object.values(SHELVES)
    .filter((shelf) => shelf.length > 0)
    .map((shelf) => shelf[Math.min(shelf.length - 1, Math.floor(pick() * shelf.length))]);
  // Shuffled, so the shelves are not a running order the reader can learn.
  for (let i = chosen.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(pick() * (i + 1)));
    [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
  }
  return chosen;
}
