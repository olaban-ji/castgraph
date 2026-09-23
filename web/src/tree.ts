// The map is a network of seeds. The film the reader searched is the first
// seed; it blows out through its cast and directors to other films. Each
// of those is a seed in turn and blows out the same way. A film is one
// card, placed the first time it is seen; a later seed that reaches it
// adds an edge instead of a second card. Popularity ranks the blow-out
// (who fans first), it does not decide whether a hop exists.

import type { ApiNode, Pathway, PathwayFilm, Pathways } from './api';

export interface MapFilm {
  id: string; // movie node id
  movie: ApiNode;
  year: number;
  /** True only for the searched film. First-ring cards still use the
   *  larger "trunk" size; there is no gold spine. */
  trunk: boolean;
  anchor: boolean;
  /** Seed this film blew out of; undefined only for the searched film. */
  parent?: string;
  /** Which side of the parent the card hangs on. */
  side: 1 | -1;
  /** Person connecting this film to its parent, their role in this film
   *  and billing in it (1-based). Role is "Director" for a directing hop. */
  relation: string;
  relationPersonId: string;
  role: string;
  billing: number;
  /** 0 for the searched film, +1 per blow-out. */
  depth: number;
}

/** An extra edge: a seed reached a film that was already on the map. */
export interface MapLink {
  from: string;
  to: string;
  relation: string;
  relationPersonId: string;
  role: string;
  billing: number;
}

export interface MapTree {
  anchorId: string;
  films: Map<string, MapFilm>; // insertion order = placement order
  /** Stops whose pathways have been applied. */
  expanded: Set<string>;
  /** Stops that have had a search-sized blow-out (the search itself, or
   *  a card the reader asked to go deep on). */
  deepened: Set<string>;
  /** Cross-edges that are not a film's placement parent. */
  links: MapLink[];
}

// Every seed blows out the same way. Caps are per seed, not a dying
// fraction of 360°. Depth is not capped: scrolling pays for the crawl.
export const RULES = {
  /** People of the searched film that blow out. */
  seedPeople: 10,
  /** Films per person from the searched film. */
  seedFilms: 6,
  /** People of any later seed that blow out. */
  stopPeople: 8,
  /** Films per person from a later seed. */
  stopFilms: 3,
  /** Extra films to ask the API for, so a title already on the map can
   *  become a network edge and the next film still hangs. */
  candidateSlack: 2,
  /** Billing penalty λ in φ(o) = 1/(1+λo). Directing is o = 0. */
  orderWeight: 0.2,
  /** Only films at least this many people have rated. */
  minVotes: 200,
  /** A vote count is accumulated attention, so it also measures age: a
   *  2025 release cannot out-vote a 1997 one, and a star's new film is
   *  ranked off the map behind their back catalogue. Rather than reweigh
   *  the ranking, which would cost an older film its place, a person gets
   *  `recentSlots` extra films that only work this recent can fill.
   *
   *  Three, because recent work is not evenly spread: of the people on a
   *  map with any, 73% have one film, 16% two and 7% three. Three slots
   *  carry 95% of it; the rest is a thin tail of the very prolific, whose
   *  year would otherwise crowd out everyone else's. */
  recentYears: 2,
  recentSlots: 3,
  /** Floor inside log(1 + π) so a missing popularity is not a zero weight. */
  popularityFloor: 0.1,
};

/** Caps for one blow-out. */
export interface BlowCaps {
  people: number;
  films: number;
}

/** Search-sized fan: used for the first seed and for an explicit deepen. */
export const SEED_CAPS: BlowCaps = {
  people: RULES.seedPeople,
  films: RULES.seedFilms,
};

/** How many people of a seed to blow out (and to request). */
export function peopleFor(stop: MapFilm): number {
  return stop.anchor ? RULES.seedPeople : RULES.stopPeople;
}

/** How many films each of those people may hang from this seed. */
export function filmsPer(stop: MapFilm): number {
  return stop.anchor ? RULES.seedFilms : RULES.stopFilms;
}

/** Scroll-growth caps for a stop. The search and an explicit deepen use
 *  SEED_CAPS instead. */
export function stopCaps(stop: MapFilm): BlowCaps {
  return { people: peopleFor(stop), films: filmsPer(stop) };
}

/** Directors of a seed always blow out; they do not compete with the
 *  billed cast for people slots. */
export function isDirectorHop(hop: Pick<Hop, 'personRole' | 'film'>): boolean {
  return hop.personRole === 'Director' || hop.film.role === 'Director';
}

/** Films to ask the API for per person. */
export function filmsRequested(stop: MapFilm): number {
  return filmsPer(stop) + RULES.candidateSlack;
}

/** The filter every pathways request carries. Billing is not cut off;
 *  hopScore penalises it continuously. */
export const PATHWAY_FILTER = {
  billing: 0,
  minVotes: RULES.minVotes,
};

/** φ(o) = 1/(1+λo). */
export function phi(order: number): number {
  return 1 / (1 + RULES.orderWeight * Math.max(0, order));
}

/** log(1+π(p)) · φ(o(p,m)). */
export function personWeight(popularity: number | undefined, order: number): number {
  return Math.log1p(Math.max(popularity ?? 0, RULES.popularityFloor)) * phi(order);
}

/** The release year from which a film counts as recent. Read from the
 *  clock, so the window moves with it. */
export function recentFrom(now: Date = new Date()): number {
  return now.getFullYear() - RULES.recentYears;
}

/** Whether a film is new enough to claim a person's reserved slot. */
export function isRecent(year: number | undefined, now?: Date): boolean {
  return year != null && year >= recentFrom(now);
}

/** log(1+votes(f)) · φ(o(p,f)). */
export function filmWeight(votes: number | undefined, order: number): number {
  return Math.log1p(Math.max(votes ?? 0, 0)) * phi(order);
}

/** σ = w_P(p,m) · w_F(f,p). Ranks the blow-out; does not gate it. */
export function hopScore(
  popularity: number | undefined,
  personOrder: number,
  film: Pick<PathwayFilm, 'votes' | 'order'>,
): number {
  return personWeight(popularity, personOrder) * filmWeight(film.votes, film.order);
}

export interface Hop {
  person: ApiNode;
  personOrder: number;
  personRole: string;
  film: PathwayFilm;
  score: number;
  index: number;
}

/** Hops from a seed, heaviest first. skip is people not to travel through
 *  (the person who led to this seed, so we do not bounce straight back). */
export function rankHops(cast: Pathway[], skip: Set<string>): Hop[] {
  const hops: Hop[] = [];
  for (const pw of cast) {
    if (skip.has(pw.person.id)) continue;
    for (const film of pw.films) {
      if (!film.year) continue;
      const score = hopScore(pw.person.popularity, pw.order, film);
      if (score <= 0) continue;
      hops.push({
        person: pw.person,
        personOrder: pw.order,
        personRole: pw.role,
        film,
        score,
        index: hops.length,
      });
    }
  }
  hops.sort(
    (a, b) =>
      b.score - a.score ||
      (b.film.votes ?? 0) - (a.film.votes ?? 0) ||
      a.personOrder - b.personOrder ||
      a.index - b.index,
  );
  return hops;
}

/** Which relation types the reader wants on the map. */
export interface RelationFilters {
  cast: boolean;
  director: boolean;
}

/** Drops the hops the reader has switched off, before they reach the
 *  tree. Filtering here rather than at the edge means a switched-off
 *  relation never grows the map either. */
export function filterPathways(pw: Pathways, f: RelationFilters): Pathways {
  if (f.cast && f.director) return pw;
  const cast: Pathway[] = [];
  for (const p of pw.cast) {
    const films = p.films.filter((film) =>
      isDirectorHop({ personRole: p.role, film }) ? f.director : f.cast,
    );
    if (films.length > 0) cast.push({ ...p, films });
  }
  return { ...pw, cast };
}

/** A one-film map from what a search result already told us, so the
 *  anchor card and the year rail are on screen while its pathways load. */
export function provisionalPathways(movie: ApiNode): Pathways {
  return { movie, cast: [] };
}

/** Builds the network from the searched film's pathways. */
export function buildTree(pw: Pathways): MapTree {
  const anchor = pw.movie;
  if (!anchor.year)
    throw new Error(`${anchor.label} has no release year to place it by`);

  const hops = rankHops(pw.cast, new Set());
  const face = hops[0];
  const tree: MapTree = {
    anchorId: anchor.id,
    films: new Map(),
    expanded: new Set(),
    deepened: new Set(),
    links: [],
  };
  tree.films.set(anchor.id, {
    id: anchor.id,
    movie: anchor,
    year: anchor.year,
    trunk: true,
    anchor: true,
    side: 1,
    relation: face?.person.label ?? '',
    relationPersonId: face?.person.id ?? '',
    role: face?.personRole ?? '',
    billing: (face?.personOrder ?? 0) + 1,
    depth: 0,
  });

  blowOut(tree, anchor.id, hops, SEED_CAPS);
  tree.expanded.add(anchor.id);
  tree.deepened.add(anchor.id);
  return tree;
}

/** Blows a seed out through its pathways. Returns true if the network changed. */
export function extendTree(
  tree: MapTree,
  movieId: string,
  pw: Pathways,
): boolean {
  const film = tree.films.get(movieId);
  if (!film || tree.expanded.has(movieId)) return false;
  tree.expanded.add(movieId);
  // An inbound actor would only lead back through the same career. The
  // director of this film is the opposite: their other titles are why
  // you opened it (Strangelove → Clockwork Orange).
  const skip = new Set<string>();
  if (film.role !== 'Director') skip.add(film.relationPersonId);
  const hops = rankHops(pw.cast, skip);
  return blowOut(tree, movieId, hops, stopCaps(film));
}

/** Search-sized blow-out of a card already on the map. Existing titles
 *  gain edges; new ones hang. The inbound person is not skipped: the
 *  reader asked to open this film fully. */
export function deepenTree(
  tree: MapTree,
  movieId: string,
  pw: Pathways,
): boolean {
  const film = tree.films.get(movieId);
  if (!film || film.anchor || tree.deepened.has(movieId)) return false;
  tree.deepened.add(movieId);
  tree.expanded.add(movieId);
  return blowOut(tree, movieId, rankHops(pw.cast, new Set()), SEED_CAPS);
}

/** Everything the map has been told of one person, hung off a seed they
 *  stand on. Filtering to a person is a request to see that career, not
 *  the slice of it the map happened to grow, so the per-person cap does
 *  not apply here — what the API was asked for is the bound. */
export function widenPerson(tree: MapTree, movieId: string, pw: Pathways): boolean {
  if (!tree.films.has(movieId)) return false;
  tree.expanded.add(movieId);
  return blowOut(tree, movieId, rankHops(pw.cast, new Set()), {
    people: Infinity,
    films: Infinity,
  });
}

/** The map's id for a person, found by the name the filters go by. */
export function personIdByName(tree: MapTree, name: string): string | null {
  for (const f of tree.films.values()) {
    if (f.relation === name && f.relationPersonId) return f.relationPersonId;
  }
  for (const l of tree.links) {
    if (l.relation === name && l.relationPersonId) return l.relationPersonId;
  }
  return null;
}

/** The films a person's edges leave from: the seeds their career can be
 *  widened out of. */
export function seedsOfPerson(tree: MapTree, personId: string): string[] {
  const out = new Set<string>();
  for (const f of tree.films.values()) {
    if (f.relationPersonId === personId && f.parent) out.add(f.parent);
  }
  for (const l of tree.links) {
    if (l.relationPersonId === personId) out.add(l.from);
  }
  return [...out];
}

/** A non-search card that has not already had a search-sized blow-out. */
export function canDeepen(tree: MapTree, filmId: string): boolean {
  const film = tree.films.get(filmId);
  return !!film && !film.anchor && !tree.deepened.has(filmId);
}

/** Stops still waiting to blow out. */
export function expandable(tree: MapTree): MapFilm[] {
  return [...tree.films.values()].filter((f) => !tree.expanded.has(f.id));
}

function toFilm(
  hop: Hop,
  extra: { depth: number; side: 1 | -1; parent: string },
): MapFilm {
  return {
    id: hop.film.id,
    movie: hop.film,
    year: hop.film.year!,
    trunk: extra.depth === 1,
    anchor: false,
    parent: extra.parent,
    side: extra.side,
    relation: hop.person.label,
    relationPersonId: hop.person.id,
    role: hop.film.role,
    billing: hop.film.order + 1,
    depth: extra.depth,
  };
}

/** Fans a seed's ranked hops: new films hang off it, films already on the
 *  map gain a network edge. Directors of the seed always blow out; billed
 *  people then fill the remaining fan. Per-person caps apply either way. */
function blowOut(tree: MapTree, seedId: string, hops: Hop[], caps: BlowCaps): boolean {
  const seed = tree.films.get(seedId)!;
  const used = new Map<string, Quota>();
  let side: 1 | -1 = seed.anchor ? -1 : seed.side;
  let changed = false;

  const place = (batch: Hop[], maxPeople: number): void => {
    let people = 0;
    for (const hop of batch) {
      if (hop.film.id === seedId) continue;
      const next = claim(used, hop.person.id, people, maxPeople, caps.films, isRecent(hop.film.year));
      if (next === null) continue;
      people = next;
      if (tree.films.has(hop.film.id)) {
        if (link(tree, seedId, hop)) changed = true;
        continue;
      }
      tree.films.set(
        hop.film.id,
        toFilm(hop, { depth: seed.depth + 1, side, parent: seedId }),
      );
      side = side === 1 ? -1 : 1;
      changed = true;
    }
  };

  place(hops.filter(isDirectorHop), Infinity);
  place(hops.filter((h) => !isDirectorHop(h)), caps.people);
  return changed;
}

/** What a person has taken of this seed's fan. */
interface Quota {
  films: number;
  /** How many of their reserved slots for recent work are spent. Only a
   *  film past the cap spends one: work recent enough to rank on its own
   *  votes costs nothing extra. */
  extra: number;
}

/** Records one hop against a person's quota. Returns the updated people
 *  count, or null if this person is full or the seed is. A person at
 *  their cap still has `recentSlots` places left that only their newest
 *  work can fill — extra places on the map rather than places taken off
 *  their older films. */
function claim(
  used: Map<string, Quota>,
  personId: string,
  people: number,
  maxPeople: number,
  maxFilms: number,
  recent: boolean,
): number | null {
  const q = used.get(personId) ?? { films: 0, extra: 0 };
  if (q.films >= maxFilms) {
    if (!recent || q.extra >= RULES.recentSlots) return null;
    // Already counted against the seed's people budget by their first film.
    used.set(personId, { films: q.films + 1, extra: q.extra + 1 });
    return people;
  }
  if (q.films === 0 && Number.isFinite(maxPeople) && people >= maxPeople) return null;
  used.set(personId, { films: q.films + 1, extra: q.extra });
  return q.films === 0 ? people + 1 : people;
}

function link(tree: MapTree, from: string, hop: Hop): boolean {
  const to = hop.film.id;
  const placed = tree.films.get(to);
  if (!placed || placed.parent === from) return false;
  if (tree.links.some((l) => l.from === from && l.to === to)) return false;
  tree.links.push({
    from,
    to,
    relation: hop.person.label,
    relationPersonId: hop.person.id,
    role: hop.film.role,
    billing: hop.film.order + 1,
  });
  return true;
}
