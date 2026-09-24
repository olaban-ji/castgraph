import { describe, expect, it } from 'vitest';
import {
  filmHref,
  filmPath,
  movieIdFrom,
  movieIdFromPath,
  movieIdFromState,
  HOME_TITLE,
  pageTitle,
  routeFrom,
  slugify,
} from './movieParam';

describe('movieIdFrom', () => {
  it('accepts positive integers only', () => {
    expect(movieIdFrom('603')).toBe(603);
    expect(movieIdFrom('0')).toBeNull();
    expect(movieIdFrom('-3')).toBeNull();
    expect(movieIdFrom('abc')).toBeNull();
    expect(movieIdFrom(null)).toBeNull();
  });
});

describe('movieIdFromState', () => {
  it('reads the id a pushState left behind', () => {
    expect(movieIdFromState({ movie: 603 })).toBe(603);
    expect(movieIdFromState({ movie: 'x' })).toBeNull();
    expect(movieIdFromState(null)).toBeNull();
  });
});

describe('slugify', () => {
  it('makes a title safe to paste into a URL', () => {
    expect(slugify('The Matrix')).toBe('the-matrix');
    expect(slugify("Ocean's Eleven")).toBe('oceans-eleven');
    expect(slugify('Amélie')).toBe('amelie');
    // NFKD keeps the digits of a fraction rather than dropping them: ugly,
    // but the id is what the route reads and nothing is lost.
    expect(slugify('9½ Weeks!')).toBe('91-2-weeks');
    expect(slugify('WALL·E')).toBe('wall-e');
  });
  it('never ends in a hyphen, even when truncated', () => {
    expect(slugify('a'.repeat(58) + ' bb')).not.toMatch(/-$/);
  });
});

describe('filmPath', () => {
  it('is id plus slug, and id alone before the title is known', () => {
    expect(filmPath(603, 'The Matrix')).toBe('/movie/603-the-matrix');
    expect(filmPath(603)).toBe('/movie/603');
  });
});

describe('movieIdFromPath', () => {
  it('reads the id whatever the slug says', () => {
    expect(movieIdFromPath('/movie/603-the-matrix')).toBe(603);
    expect(movieIdFromPath('/movie/603')).toBe(603);
    expect(movieIdFromPath('/movie/603-anything-at-all/')).toBe(603);
  });
  it('still reads the address maps used to have', () => {
    expect(movieIdFromPath('/film/603-the-matrix')).toBe(603);
    expect(movieIdFromPath('/film/603')).toBe(603);
  });
  it('rejects anything that is not a movie route', () => {
    expect(movieIdFromPath('/')).toBeNull();
    expect(movieIdFromPath('/movie/')).toBeNull();
    expect(movieIdFromPath('/movie/abc')).toBeNull();
    expect(movieIdFromPath('/movies/603')).toBeNull();
    expect(movieIdFromPath('/films/603')).toBeNull();
  });
});

describe('routeFrom', () => {
  it('keeps a movie route as it is', () => {
    expect(routeFrom('https://x.test/movie/603-the-matrix')).toEqual({
      movieId: 603,
      path: '/movie/603-the-matrix',
    });
  });
  it('moves an old /film/ link over, slug and all', () => {
    expect(routeFrom('https://x.test/film/603-the-matrix')).toEqual({
      movieId: 603,
      path: '/movie/603-the-matrix',
    });
    expect(routeFrom('https://x.test/film/603-the-matrix?device=phone').path).toBe(
      '/movie/603-the-matrix?device=phone',
    );
  });
  it('upgrades a legacy ?movie= link to a movie route', () => {
    expect(routeFrom('https://x.test/?movie=603')).toEqual({
      movieId: 603,
      path: '/movie/603',
    });
  });
  it('keeps other query pins when upgrading', () => {
    expect(routeFrom('https://x.test/?movie=603&device=phone')).toEqual({
      movieId: 603,
      path: '/movie/603?device=phone',
    });
  });
  it('leaves a cold start alone', () => {
    expect(routeFrom('https://x.test/?device=phone')).toEqual({
      movieId: null,
      path: '/?device=phone',
    });
  });
});

describe('filmHref', () => {
  it('moves to the movie path and keeps the query', () => {
    expect(filmHref(550, 'Fight Club', 'https://x.test/movie/603-the-matrix?device=phone')).toBe(
      '/movie/550-fight-club?device=phone',
    );
  });
});

describe('pageTitle', () => {
  it('names the movie the map is of', () => {
    expect(pageTitle('The Matrix')).toBe(
      'The Matrix — everything its cast and directors made · Cinedikt',
    );
  });

  it('falls back to the tagline before a title is known, and on first run', () => {
    expect(pageTitle()).toBe(HOME_TITLE);
    expect(pageTitle(undefined)).toBe(HOME_TITLE);
    expect(pageTitle('')).toBe(HOME_TITLE);
    // A title that is only spaces would leave the tab reading " — everything…".
    expect(pageTitle('   ')).toBe(HOME_TITLE);
  });

  it('matches the tagline the page is served with', () => {
    expect(HOME_TITLE).toBe('Cinedikt — a movie’s cast and directors, and everything they made');
  });
});
