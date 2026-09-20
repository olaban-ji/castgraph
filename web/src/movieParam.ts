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

/** Path + remaining query/hash, with ?movie= removed so the address bar
 *  stays clean while other pins (e.g. ?device=) are kept. */
export function urlWithoutMovie(href: string): string {
  const url = new URL(href);
  url.searchParams.delete('movie');
  return url.pathname + url.search + url.hash;
}
