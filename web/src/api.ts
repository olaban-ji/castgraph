// Thin client for the castgraph Go API. In dev, Vite proxies /api to :8080.

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
}

/** A film in a pathway, with the connecting actor's role in it. */
export interface PathwayFilm extends ApiNode {
  role: string;
  order: number;
}

/** One cast member of a movie with their most voted other films. */
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
}

const BASE = '/api';

async function getJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, init);
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

export interface PathwayFilter {
  /** Only cast billed at or above this position, and only their films
   *  where they are billed likewise. */
  billing: number;
  /** Only films with at least this many TMDb votes. */
  minVotes: number;
}

/** A stop's pathways. The API crawls the movie first if it never was, and
 *  warms the films it hands back so the next hop is ready. */
export function fetchPathways(
  movieId: number,
  costars: number,
  films: number,
  filter: PathwayFilter,
  signal?: AbortSignal,
): Promise<Pathways> {
  const q = `costars=${costars}&films=${films}&billing=${filter.billing}&min_votes=${filter.minVotes}`;
  return getJSON<Pathways>(`/movies/${movieId}/pathways?${q}`, { signal });
}

export async function searchMovies(q: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const res = await getJSON<{ results: SearchHit[] }>(
    `/search/movies?q=${encodeURIComponent(q)}`,
    { signal },
  );
  return res.results;
}
