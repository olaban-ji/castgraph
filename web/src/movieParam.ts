import { useEffect } from 'react';

/** A map lives at /movie/tt0133093-the-matrix. The id is IMDb's own, and
 *  the slug is there so a pasted link says what it opens. A map nobody
 *  can link is a map nobody shares. */

/** An IMDb title id: "tt" and at least one digit. Ids have grown over
 *  the years, so the length is not assumed. */
const TCONST = /^tt\d{1,17}$/;

export function movieIdFrom(raw: string | null): string | null {
  if (!raw) return null;
  return TCONST.test(raw) ? raw : null;
}

export function movieIdFromState(state: unknown): string | null {
  if (!state || typeof state !== 'object' || !('movie' in state)) return null;
  const id = (state as { movie: unknown }).movie;
  return typeof id === 'string' ? movieIdFrom(id) : null;
}

/** The id in /movie/<tconst>[-slug]. Anything else is not a route. */
export function movieIdFromPath(pathname: string): string | null {
  const m = /^\/movie\/(tt\d{1,17})(?:-[^/]*)?\/?$/.exec(pathname);
  return m ? movieIdFrom(m[1]) : null;
}

/** Lower-case, hyphenated, ASCII-ish: a slug that survives being pasted
 *  into a chat window. */
export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

/** The canonical path for a movie. The title is optional: an id alone is
 *  a valid route, and the slug is added once the title is known. */
export function filmPath(id: string, title?: string): string {
  const slug = title ? slugify(title) : '';
  return slug ? `/movie/${id}-${slug}` : `/movie/${id}`;
}

/** Where the app should be, given any URL it can be reached by: a movie
 *  route, or the cold start at /.
 *
 *  There is no legacy `?movie=` any more. It carried a TMDb id, and TMDb
 *  ids are not addresses in this catalog — keeping it would have turned
 *  an old link into a route that looks valid and opens nothing. */
export function routeFrom(href: string): { movieId: string | null; path: string } {
  const url = new URL(href);
  const fromPath = movieIdFromPath(url.pathname);
  if (fromPath !== null) {
    return { movieId: fromPath, path: url.pathname + url.search + url.hash };
  }
  return { movieId: null, path: url.pathname + url.search + url.hash };
}

/** What the tab says. Naming the movie is the point: a reader with half
 *  a dozen maps open should be able to tell them apart, and a link
 *  previewed in a chat should say what it opens.
 *
 *  Both views share it so the two never drift. */
export const HOME_TITLE = 'Cinedikt — a movie’s cast and directors, and everything they made';

export function pageTitle(title?: string): string {
  const named = title?.trim();
  return named ? `${named} — everything its cast and directors made · Cinedikt` : HOME_TITLE;
}

/** Puts the movie's name in the tab, and takes it out again on the way
 *  back to first run. */
export function usePageTitle(title: string | undefined): void {
  useEffect(() => {
    document.title = pageTitle(title);
  }, [title]);
}

/** Keep pins like ?device= while moving to a movie's own path. */
export function filmHref(id: string, title: string | undefined, href: string): string {
  const url = new URL(href);
  return filmPath(id, title) + url.search + url.hash;
}
