/** A map lives at /movie/603-the-matrix. The id is what the app reads;
 *  the slug is there so a pasted link says what it opens. A map nobody
 *  can link is a map nobody shares.
 *
 *  Maps used to live at /film/. Those links are out in the world for
 *  good, so they are still read — and turned into /movie/ ones, so there
 *  is only ever the new address on screen. */

export function movieIdFrom(raw: string | null): number | null {
  if (!raw) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function movieIdFromState(state: unknown): number | null {
  if (!state || typeof state !== 'object' || !('movie' in state)) return null;
  const id = (state as { movie: unknown }).movie;
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
}

/** The id in /movie/<id>[-slug], or in the /film/ address it used to
 *  have. Anything else is not a movie route. */
export function movieIdFromPath(pathname: string): number | null {
  const m = /^\/(?:movie|film)\/(\d+)(?:-[^/]*)?\/?$/.exec(pathname);
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
export function filmPath(id: number, title?: string): string {
  const slug = title ? slugify(title) : '';
  return slug ? `/movie/${id}-${slug}` : `/movie/${id}`;
}

/** Where the app should be, given any URL it can be reached by: a movie
 *  route, the /film/ one it used to be, a legacy ?movie=, or the cold
 *  start at /.
 *
 *  An old path keeps its slug on the way over — it is the same map, and
 *  re-deriving the slug would need a title nobody has yet. */
export function routeFrom(href: string): { movieId: number | null; path: string } {
  const url = new URL(href);
  const fromPath = movieIdFromPath(url.pathname);
  if (fromPath !== null) {
    const path = url.pathname.replace(/^\/film\//, '/movie/');
    return { movieId: fromPath, path: path + url.search + url.hash };
  }
  const legacy = movieIdFrom(url.searchParams.get('movie'));
  if (legacy !== null) {
    url.searchParams.delete('movie');
    return { movieId: legacy, path: filmPath(legacy) + url.search + url.hash };
  }
  return { movieId: null, path: url.pathname + url.search + url.hash };
}

/** Keep pins like ?device= while moving to a movie's own path. */
export function filmHref(id: number, title: string | undefined, href: string): string {
  const url = new URL(href);
  return filmPath(id, title) + url.search + url.hash;
}
