// Thin client for the cinedikt Go API. In dev, Vite proxies /api to :8080.

import { analyticsHeaders } from './analytics';

export type NodeKind = 'movie' | 'person';

export interface ApiNode {
  id: string; // "m:603" | "p:6384"
  type: NodeKind;
  label: string;
  tmdb_id: number;
  year?: number;
  poster?: string;
  backdrop?: string; // landscape still, for wide tiles
  rating?: number; // TMDb 0–10
  votes?: number;
  imdb_id?: string;
  imdb_rating?: number;
  imdb_votes?: number;
  /** TMDb person popularity; present on person nodes. */
  popularity?: number;
}

/** A film in a pathway, with the connecting actor's role in it. */
export interface PathwayFilm extends ApiNode {
  role: string;
  order: number;
}

/** One cast member of a movie with their most voted other films.
 *  Role is the character name, or "Director". */
export interface Pathway {
  person: ApiNode;
  role: string;
  order: number;
  films: PathwayFilm[];
}

/** The lean expansion of one stop: everything the map needs to grow from it. */
export interface Pathways {
  movie: ApiNode;
  cast: Pathway[];
}

export interface SearchHit {
  id: number;
  title: string;
  release_date: string;
  /** Poster URL, so a result row shows the film rather than describing it. */
  poster?: string;
}

const BASE = '/api';

async function getJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(analyticsHeaders())) {
    if (!headers.has(k)) headers.set(k, v);
  }
  const res = await fetch(BASE + path, { ...init, headers });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // not JSON; keep the status line
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

/** A stop's pathways. The API crawls the movie first if it never was, and
 *  warms the films it hands back so the next hop is ready. Billing and the
 *  vote floor are the API's own defaults: the map has only ever wanted one
 *  set of values, so it does not restate them on every request. */
export function fetchPathways(
  movieId: number,
  costars: number,
  films: number,
  opts: {
    /** Narrow the answer to one person's career, by TMDb id. */
    person?: number;
    signal?: AbortSignal;
  } = {},
): Promise<Pathways> {
  const q = `costars=${costars}&films=${films}${opts.person ? `&person=${opts.person}` : ''}`;
  return getJSON<Pathways>(`/movies/${movieId}/pathways?${q}`, { signal: opts.signal });
}

/** Eight films to start a map from, a different eight each time, one per
 *  era so the screen spans the century. The API answers with nothing when
 *  the graph is unreachable; the caller keeps a built-in set for that. */
export async function fetchFirstRun(signal?: AbortSignal): Promise<FirstRunHit[]> {
  const res = await getJSON<{ results: FirstRunHit[] }>('/first-run', { signal });
  return res.results ?? [];
}

export interface FirstRunHit {
  id: number;
  title: string;
  year: number;
  poster: string;
}

export async function searchMovies(
  q: string,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const res = await getJSON<{ results: SearchHit[] }>(
    `/search/movies?q=${encodeURIComponent(q)}`,
    { signal },
  );
  return res.results;
}
