// What the reader wants to see of the map they already have. Filters hide
// cards and lines; they never delete them, and the searched film always
// stays — a map with no centre is not a map.

import type { Edge, Layout, PlacedFilm } from './layout';

export interface MapFilters {
  /** Relation types to travel and to draw. */
  cast: boolean;
  director: boolean;
  /** Lowest rating a film may have, 0 for no floor. A film with no
   *  rating at all cannot be shown to clear a floor, so a floor hides it. */
  minRating: number;
  /** Inclusive year window; null means unbounded on that side. */
  fromYear: number | null;
  toYear: number | null;
  /** Show only films this person connects. Their name, as the edges
   *  spell it; null for everyone. */
  person: string | null;
}

export const NO_FILTERS: MapFilters = {
  cast: true,
  director: true,
  minRating: 0,
  fromYear: null,
  toYear: null,
  person: null,
};

export function isFiltered(f: MapFilters): boolean {
  return (
    !f.cast ||
    !f.director ||
    f.minRating > 0 ||
    f.fromYear !== null ||
    f.toYear !== null ||
    f.person !== null
  );
}

/** The rating a filter compares against: IMDb when we have it, else TMDb. */
export function ratingOf(film: PlacedFilm): number | null {
  return film.movie.imdb_rating ?? film.movie.rating ?? null;
}

/** Everyone the current map connects films through, most-used first —
 *  the only people worth offering as a filter, because they are the only
 *  ones the map can answer about. */
export function peopleOnMap(edges: Edge[]): { name: string; films: number; director: boolean }[] {
  const seen = new Map<string, { name: string; films: Set<string>; director: boolean }>();
  for (const e of edges) {
    if (!e.actor) continue;
    const row = seen.get(e.actor) ?? { name: e.actor, films: new Set<string>(), director: e.director };
    row.films.add(e.from.id);
    row.films.add(e.to.id);
    row.director = row.director || e.director;
    seen.set(e.actor, row);
  }
  return [...seen.values()]
    .map((r) => ({ name: r.name, films: r.films.size, director: r.director }))
    .sort((a, b) => b.films - a.films || a.name.localeCompare(b.name));
}

/** The year span the map covers, for the range control's bounds. */
export function yearBounds(films: PlacedFilm[]): { min: number; max: number } {
  if (films.length === 0) return { min: 0, max: 0 };
  let min = Infinity;
  let max = -Infinity;
  for (const f of films) {
    if (f.year < min) min = f.year;
    if (f.year > max) max = f.year;
  }
  return { min, max };
}

/** Films a person connects: both ends of every edge they stand for. */
function filmsOfPerson(edges: Edge[], person: string): Set<string> {
  const ids = new Set<string>();
  for (const e of edges) {
    if (e.actor !== person) continue;
    ids.add(e.from.id);
    ids.add(e.to.id);
  }
  return ids;
}

/** Which films survive the filters. The searched film always does. */
export function visibleFilms(layout: Layout, f: MapFilters): Set<string> | null {
  if (!isFiltered(f)) return null;
  const byPerson = f.person ? filmsOfPerson(layout.edges, f.person) : null;
  const relationOk = relationVisibility(layout.edges, f);
  const ids = new Set<string>();
  for (const film of layout.placed) {
    if (film.anchor) {
      ids.add(film.id);
      continue;
    }
    if (byPerson && !byPerson.has(film.id)) continue;
    if (f.fromYear !== null && film.year < f.fromYear) continue;
    if (f.toYear !== null && film.year > f.toYear) continue;
    if (f.minRating > 0) {
      const r = ratingOf(film);
      if (r === null || r < f.minRating) continue;
    }
    if (relationOk && !relationOk.has(film.id)) continue;
    ids.add(film.id);
  }
  return ids;
}

/** Films still reachable once a relation type is switched off. A film
 *  whose only line was a directing hop has nothing to say when direction
 *  is hidden, so it goes with it. */
function relationVisibility(edges: Edge[], f: MapFilters): Set<string> | null {
  if (f.cast && f.director) return null;
  const ids = new Set<string>();
  for (const e of edges) {
    if (e.director ? !f.director : !f.cast) continue;
    ids.add(e.from.id);
    ids.add(e.to.id);
  }
  return ids;
}

/** An edge is drawn when its relation type is wanted and both of its
 *  films are still on the map. */
export function edgeVisible(e: Edge, f: MapFilters, films: Set<string> | null): boolean {
  if (e.director ? !f.director : !f.cast) return false;
  if (f.person !== null && e.actor !== f.person) return false;
  if (!films) return true;
  return films.has(e.from.id) && films.has(e.to.id);
}

/** One line saying what is being hidden, for the reader who wonders
 *  where their map went. */
export function filterSummary(f: MapFilters, shown: number, total: number): string {
  if (!isFiltered(f)) return `${total} films`;
  return `${shown} of ${total} films`;
}
