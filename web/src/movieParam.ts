/** A map lives at /film/603-the-matrix. The id is what the app reads; the
 *  slug is there so a pasted link says what it opens. A map nobody can
 *  link is a map nobody shares. */

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

/** The id in /film/<id>[-slug]. Anything else is not a film route. */
export function movieIdFromPath(pathname: string): number | null {
  const m = /^\/film\/(\d+)(?:-[^/]*)?\/?$/.exec(pathname);
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

/** The canonical path for a film. The title is optional: an id alone is
 *  a valid route, and the slug is added once the title is known. */
export function filmPath(id: number, title?: string): string {
  const slug = title ? slugify(title) : '';
  return slug ? `/film/${id}-${slug}` : `/film/${id}`;
}

/** Where the app should be, given any URL it can be reached by: a film
 *  route, a legacy ?movie=, or the cold start at /. */
export function routeFrom(href: string): { movieId: number | null; path: string } {
  const url = new URL(href);
  const fromPath = movieIdFromPath(url.pathname);
  if (fromPath !== null) return { movieId: fromPath, path: url.pathname + url.search + url.hash };
  const legacy = movieIdFrom(url.searchParams.get('movie'));
  if (legacy !== null) {
    url.searchParams.delete('movie');
    return { movieId: legacy, path: filmPath(legacy) + url.search + url.hash };
  }
  return { movieId: null, path: url.pathname + url.search + url.hash };
}

/** Keep pins like ?device= while moving to a film's own path. */
export function filmHref(id: number, title: string | undefined, href: string): string {
  const url = new URL(href);
  return filmPath(id, title) + url.search + url.hash;
}
