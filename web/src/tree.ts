// The map's tree: an anchor, a trunk of the lead actor's films, and branch
// films hung off any stop via a shared cast member or director. It is grown one stop
// at a time from /pathways responses and only ever grows; a film's parent
// is fixed the moment it is placed, so cards never jump between pathways.

import type { ApiNode, Pathways } from './api';

export interface MapFilm {
  id: string; // movie node id
  movie: ApiNode;
  year: number;
  trunk: boolean;
  anchor: boolean;
  /** Parent film id for branches; undefined for the anchor and trunk. */
  parent?: string;
  /** Which side of the parent the branch hangs on. */
  side: 1 | -1;
  /** Name of the person that connects this film to its parent (or to the
   *  anchor, for trunk films), their role in this film and their billing
   *  in it (1-based). Role is "Director" for a directing hop. */
  relation: string;
  relationPersonId: string;
  role: string;
  billing: number;
  /** 0 for anchor and trunk, +1 per branch level. */
  depth: number;
}

export interface MapTree {
  anchorId: string;
  films: Map<string, MapFilm>; // insertion order = placement order
  /** Stops whose pathways have been applied. */
  expanded: Set<string>;
  leadId?: string;
}

// Density rules. Real data has hundreds of candidates per stop; these keep
// the map legible. Depth is not capped: a stop keeps growing as long as
// the reader scrolls towards it, which is what pays for the crawl. What
// decays with distance from the anchor is breadth: rich around the film
// the reader asked about, single routes further out.
export const RULES = {
  /** Trunk stops: the lead actor's most voted films. */
  trunkMax: 10,
  /** Co-stars of the anchor that each get a pathway. */
  anchorCostars: 6,
  /** Films per anchor co-star. */
  anchorFilmsPerCostar: 2,
  /** Co-stars of a trunk stop that get a pathway. */
  trunkStopCostars: 2,
  /** Co-stars of any deeper stop that get a pathway: one, so a chain past
   *  the trunk reads as a route rather than a fan. */
  deepStopCostars: 1,
  /** Films per co-star at stops other than the anchor. */
  stopFilmsPerCostar: 1,
  /** Candidate films to ask the API for per co-star, so a film already on
   *  the map can be skipped for the next best one. */
  candidateFilms: 5,
  /** A connection is drawn only through an actor billed in the top N of
   *  both films: what a viewer would recognise as "they were in it". */
  maxBilling: 5,
  /** …and only to films at least this many people have rated. */
  minVotes: 200,
};

/** How many co-stars of a stop get a pathway. */
export function costarsFor(stop: MapFilm): number {
  if (stop.anchor) return RULES.anchorCostars;
  if (stop.depth === 0) return RULES.trunkStopCostars;
  return RULES.deepStopCostars;
}

/** The filter every pathways request carries. */
export const PATHWAY_FILTER = {
  billing: RULES.maxBilling,
  minVotes: RULES.minVotes,
};

/** Builds the tree from the anchor's pathways. */
export function buildTree(pw: Pathways): MapTree {
  const anchor = pw.movie;
  if (!anchor.year)
    throw new Error(`${anchor.label} has no release year to place it by`);

  const tree: MapTree = {
    anchorId: anchor.id,
    films: new Map(),
    expanded: new Set(),
  };
  const [lead, ...others] = pw.cast;
  // The anchor's own relation is its lead: "Keanu Reeves as Neo".
  tree.films.set(anchor.id, {
    id: anchor.id,
    movie: anchor,
    year: anchor.year,
    trunk: true,
    anchor: true,
    side: 1,
    relation: lead?.person.label ?? '',
    relationPersonId: lead?.person.id ?? '',
    role: lead?.role ?? '',
    billing: (lead?.order ?? 0) + 1,
    depth: 0,
  });

  if (lead) {
    tree.leadId = lead.person.id;
    for (const movie of lead.films) {
      if (trunkCount(tree) >= RULES.trunkMax) break;
      if (!movie.year || tree.films.has(movie.id)) continue;
      tree.films.set(movie.id, {
        id: movie.id,
        movie,
        year: movie.year,
        trunk: true,
        anchor: false,
        side: 1,
        relation: lead.person.label,
        relationPersonId: lead.person.id,
        role: movie.role,
        billing: movie.order + 1,
        depth: 0,
      });
    }
  }
  growBranches(
    tree,
    anchor.id,
    others,
    RULES.anchorCostars,
    RULES.anchorFilmsPerCostar,
  );
  tree.expanded.add(anchor.id);
  return tree;
}

/** Applies a stop's pathways. Returns true if the tree changed. */
export function extendTree(
  tree: MapTree,
  movieId: string,
  pw: Pathways,
): boolean {
  const film = tree.films.get(movieId);
  if (!film || tree.expanded.has(movieId)) return false;
  tree.expanded.add(movieId);
  // The actor that brought us here would only lead back the way we came,
  // and the lead already has the trunk.
  const cast = pw.cast.filter(
    (c) => c.person.id !== film.relationPersonId && c.person.id !== tree.leadId,
  );
  return growBranches(
    tree,
    movieId,
    cast,
    costarsFor(film),
    RULES.stopFilmsPerCostar,
  );
}

/** Stops still waiting for their pathways. */
export function expandable(tree: MapTree): MapFilm[] {
  return [...tree.films.values()].filter((f) => !tree.expanded.has(f.id));
}

function growBranches(
  tree: MapTree,
  parentId: string,
  cast: Pathways['cast'],
  maxCostars: number,
  filmsPerCostar: number,
): boolean {
  const parent = tree.films.get(parentId)!;
  let changed = false;
  let costars = 0;
  // Alternate sides so pathways fan out evenly, continuing the parent's
  // own lean for branches of branches.
  let side: 1 | -1 = parent.anchor ? -1 : parent.side;
  for (const { person, films } of cast) {
    if (costars >= maxCostars) break;
    let added = 0;
    for (const movie of films) {
      if (added >= filmsPerCostar) break;
      if (!movie.year || tree.films.has(movie.id)) continue;
      tree.films.set(movie.id, {
        id: movie.id,
        movie,
        year: movie.year,
        trunk: false,
        anchor: false,
        parent: parentId,
        side,
        relation: person.label,
        relationPersonId: person.id,
        role: movie.role,
        billing: movie.order + 1,
        depth: parent.depth + 1,
      });
      side = side === 1 ? -1 : 1;
      added++;
      changed = true;
    }
    if (added > 0) costars++;
  }
  return changed;
}

function trunkCount(tree: MapTree): number {
  let n = 0;
  for (const f of tree.films.values()) if (f.trunk && !f.anchor) n++;
  return n;
}
