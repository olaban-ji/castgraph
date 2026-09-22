// Tracing one person through the map.
//
// Not every film they appear in — the *route*: from the film the reader
// searched, through the hops that reach this person, to the films they
// lead on to. A star of fifteen scattered cards says "they are all over
// this map"; a route says "here is how you get from what you watched to
// them, and where they take you next", which is a thing you can follow
// with your eye and with the scroll wheel.

import type { Edge, Layout } from './layout';

export interface Trace {
  person: string;
  /** Every edge the reader should see: the route plus the person's hops. */
  edges: Set<string>;
  /** Films the route passes through, including both ends of every hop. */
  films: Set<string>;
  /** The person's own hops, drawn at full strength; the rest of the route
   *  is the context that makes them reachable. */
  through: Set<string>;
  /** Films this person connects on the map. */
  appearances: number;
  /** Those films in route order — nearest the searched film first — so the
   *  reader can walk the route rather than hunt for it. */
  stops: string[];
}

/** The route from the searched film through `person` and onward, or null
 *  if the map does not connect them. */
export function traceRoute(layout: Layout, person: string): Trace | null {
  const hops = layout.edges.filter((e) => e.actor === person);
  if (hops.length === 0) return null;

  const anchor = layout.placed.find((f) => f.anchor);
  const { parent, depth } = anchor
    ? routeParents(layout.edges, anchor.id)
    : { parent: new Map<string, Edge>(), depth: new Map<string, number>() };

  const edges = new Set<string>();
  const films = new Set<string>();
  const through = new Set<string>();
  const appearances = new Set<string>();

  for (const hop of hops) {
    through.add(hop.id);
    edges.add(hop.id);
    films.add(hop.from.id);
    films.add(hop.to.id);
    appearances.add(hop.from.id).add(hop.to.id);
    // Walk each end of the hop back to the searched film, so the lit
    // lines always start somewhere the reader recognises.
    for (const end of [hop.from.id, hop.to.id]) {
      for (const e of walkBack(parent, end)) {
        edges.add(e.id);
        films.add(e.from.id);
        films.add(e.to.id);
      }
    }
  }
  if (anchor) films.add(anchor.id);
  const stops = [...appearances].sort(
    (a, b) => (depth.get(a) ?? 1e9) - (depth.get(b) ?? 1e9) || a.localeCompare(b),
  );
  return { person, edges, films, through, appearances: appearances.size, stops };
}

/** Breadth-first from the searched film over the whole map, remembering
 *  the edge each film was first reached by. Breadth-first means the
 *  route it yields is a shortest one: one line to follow, not a thicket. */
function routeParents(
  edges: Edge[],
  anchorId: string,
): { parent: Map<string, Edge>; depth: Map<string, number> } {
  const neighbours = new Map<string, Edge[]>();
  for (const e of edges) {
    push(neighbours, e.from.id, e);
    push(neighbours, e.to.id, e);
  }
  const parent = new Map<string, Edge>();
  const depth = new Map<string, number>([[anchorId, 0]]);
  const seen = new Set<string>([anchorId]);
  let frontier = [anchorId];
  let d = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    d += 1;
    for (const id of frontier) {
      for (const e of neighbours.get(id) ?? []) {
        const other = e.from.id === id ? e.to.id : e.from.id;
        if (seen.has(other)) continue;
        seen.add(other);
        parent.set(other, e);
        depth.set(other, d);
        next.push(other);
      }
    }
    frontier = next;
  }
  return { parent, depth };
}

function walkBack(parent: Map<string, Edge>, from: string): Edge[] {
  const out: Edge[] = [];
  let at = from;
  const guard = new Set<string>();
  while (!guard.has(at)) {
    guard.add(at);
    const e = parent.get(at);
    if (!e) break;
    out.push(e);
    at = e.from.id === at ? e.to.id : e.from.id;
  }
  return out;
}

function push(m: Map<string, Edge[]>, key: string, e: Edge): void {
  const list = m.get(key);
  if (list) list.push(e);
  else m.set(key, [e]);
}

/** The role this person played in a film on the route, so a traced card
 *  says what they did *here* rather than repeating how it was placed. An
 *  edge's role is their part in `to`, so only the edge arriving at this
 *  film can answer; being at the other end of one says nothing. */
export function traceRoleIn(layout: Layout, person: string, filmId: string): string {
  for (const e of layout.edges) {
    if (e.actor !== person || e.to.id !== filmId) continue;
    if (e.director) return 'directed';
    if (e.role) return e.role;
  }
  return '';
}

/** What a traced card says instead of how it was placed: the person and
 *  what they did here. Undefined where they did nothing in this film, so
 *  the card keeps its own connection line. */
export function traceLabelFor(layout: Layout, trace: Trace, filmId: string): string | undefined {
  const role = traceRoleIn(layout, trace.person, filmId);
  if (!role) return undefined;
  return role === 'directed' ? `${trace.person} · directed` : `${trace.person} · ${role}`;
}
