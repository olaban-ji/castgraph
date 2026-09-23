// The rating grid.
//
// Y is the release year, as it has always been. Inside a year, lanes
// follow month and day so stacked cards read in calendar order — we do
// not label those, we only sit them that way. X is the rating: low on
// the left, high on the right. There are no edges — who links a film to
// the searched one is said on the card and in the panel.
//
// Everything here is pure: `layoutGrid` takes the payload, a width and
// the reader's settings, and returns positions. Nothing touches the DOM,
// so §10's acceptance checks can be made as unit tests.

export interface GridPerson {
  id: number;
  name: string;
  role: 'cast' | 'director';
  character?: string;
  order: number;
  /** How many of this person's films belong on the grid, career-wide. */
  count?: number;
}

export interface GridFilm {
  id: number;
  title: string;
  year: number;
  /** YYYY-MM-DD when we have it. The year band stacks by this, not labels. */
  released?: string;
  rating: number | null;
  poster?: string;
  people: number[];
  isAnchor: boolean;
}

export interface GridPayload {
  anchor: GridFilm;
  people: GridPerson[];
  /** The films this answer holds, not the whole career. */
  films: GridFilm[];
  moreBefore?: boolean;
  moreAfter?: boolean;
}

export interface GridSettings {
  density: 'comfortable' | 'compact';
  yearOrder: 'oldest' | 'newest';
  showUnrated: boolean;
  highlightYear: boolean;
  /** Dim anything rated below this. Null lights everything. It never
   *  removes a card: the grid's whole argument is where a film sits on
   *  the scale, and a film that leaves the page cannot make it. */
  minRating: number | null;
}

export const DEFAULT_SETTINGS: GridSettings = {
  density: 'comfortable',
  yearOrder: 'oldest',
  showUnrated: true,
  highlightYear: true,
  minRating: null,
};

/** The rungs the rating filter offers. Whole and half points, because a
 *  reader thinks in "at least a seven", not in decimals. */
export const RATING_STOPS = [6, 6.5, 7, 7.5, 8, 8.5] as const;

/** The rating domain is fixed rather than taken from the data, so the
 *  same rating sits in the same place on every map. */
export const R_LO = 3.5;
export const R_HI = 9.2;

/** Gap between cards, on both axes. */
export const GAP = 6;

/** The plot starts at the top of the scroller: the rating scale reads
 *  itself off the gridlines, so there is no axis bar to leave room for. */
export const AXIS_H = 0;

/** How far right a card may be nudged to join a lane before a new lane is
 *  opened. Beyond this the card would be lying about its rating. */
export const NUDGE_RATIO = 0.25;

export interface Metrics {
  phone: boolean;
  compact: boolean;
  cardW: number;
  cardH: number;
  /** Portrait poster on the card. The text column keeps the width the
   *  card had before the poster was added, so the markers still fit. */
  posterW: number;
  posterH: number;
  railW: number;
  plotW: number;
  unratedW: number;
  titleLines: number;
  titleSize: number;
  /** x of R_LO and R_HI, at card centres. */
  left: number;
  right: number;
}

export function metricsFor(width: number, s: GridSettings): Metrics {
  const phone = width < 640;
  const compact = s.density === 'compact' || phone;
  // The poster sits beside the title. Its width is extra: the text column
  // stays the size the markers were measured against.
  const posterW = phone ? 40 : compact ? 44 : 52;
  const posterH = Math.round(posterW * 1.5);
  const cardW = (phone ? 92 : compact ? 96 : 116) + posterW;
  const cardH = posterH + 12;
  const railW = phone ? 52 : 72;
  const plotW = Math.max(width, phone ? 820 : 980);
  const unratedW = s.showUnrated ? cardW + 16 : 0;
  const left = railW + unratedW + cardW / 2 + 10;
  const right = plotW - cardW / 2 - 16;
  return {
    phone,
    compact,
    cardW,
    cardH,
    posterW,
    posterH,
    railW,
    plotW,
    unratedW,
    titleLines: compact ? 1 : 2,
    titleSize: 12.5,
    left,
    right,
  };
}

export function clampRating(r: number): number {
  return Math.min(Math.max(r, R_LO), R_HI);
}

/** The x of a rating, at the card's centre. */
export function xOf(r: number, m: Metrics): number {
  return m.left + ((clampRating(r) - R_LO) / (R_HI - R_LO)) * (m.right - m.left);
}

export interface GridLine {
  rating: number;
  label: string;
  x: number;
  labelLeft: number;
}

/** A gridline at every whole rating the axis can show. */
export function gridLines(m: Metrics): GridLine[] {
  const out: GridLine[] = [];
  for (let r = 4; r <= 9; r++) {
    const x = Math.round(xOf(r, m));
    out.push({ rating: r, label: r.toFixed(1), x, labelLeft: x - 20 });
  }
  return out;
}

export interface Placed {
  film: GridFilm;
  left: number;
  top: number;
  lane: number;
}

export interface Row {
  year: number;
  top: number;
  height: number;
  lanes: number;
  decade: boolean;
  anchorYear: boolean;
  /** Index among rendered rows, for the alternating band. */
  index: number;
}

export interface GridLayout {
  metrics: Metrics;
  rows: Row[];
  cards: Placed[];
  lines: GridLine[];
  plotW: number;
  plotH: number;
  unratedEdge: number;
  anchor: Placed | null;
}

/** The order the server pages in: year, unrated first, rating, title. */
export function compareFilms(a: GridFilm, b: GridFilm): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.rating == null && b.rating != null) return -1;
  if (a.rating != null && b.rating == null) return 1;
  if (a.rating != null && b.rating != null && a.rating !== b.rating) return a.rating - b.rating;
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.id - b.id;
}

/** The first and last film the reader already has, in page order. The
 *  next request asks for films strictly beyond one of these. */
export function edgesOf(films: GridFilm[]): { before?: number; after?: number } {
  if (films.length === 0) return {};
  let first = films[0];
  let last = films[0];
  for (const f of films.slice(1)) {
    if (compareFilms(f, first) < 0) first = f;
    if (compareFilms(f, last) > 0) last = f;
  }
  return { before: first.id, after: last.id };
}

/** Which chronological side a scroll toward the top or bottom of the
 *  page is asking for. Newest-first puts the later years up the page. */
export function warmSide(order: 'oldest' | 'newest', edge: 'above' | 'below'): 'before' | 'after' {
  const newest = order === 'newest';
  if (edge === 'above') return newest ? 'after' : 'before';
  return newest ? 'before' : 'after';
}

/** Fold a later page of films into the ones already on the grid. */
export function mergeGrid(have: GridPayload, page: GridPayload): GridPayload {
  const films = new Map(have.films.map((f) => [f.id, f]));
  for (const f of page.films) films.set(f.id, f);
  return {
    anchor: page.anchor?.id ? page.anchor : have.anchor,
    people: page.people.length > 0 ? page.people : have.people,
    films: [...films.values()],
    moreBefore: have.moreBefore,
    moreAfter: have.moreAfter,
  };
}

/** The band of cards to have ready: the screen the reader is on, plus
 *  the same amount above it and below it. `viewH` is that screen, so a
 *  phone and a monitor warm different distances and the rule is the same.
 *  Wherever they have scrolled to, the next screen in either direction is
 *  already drawn. */
export function warmSpan(scrollTop: number, viewH: number): { top: number; bottom: number } {
  const screen = Math.max(viewH, 0);
  const at = Math.max(scrollTop, 0);
  return { top: at - screen, bottom: at + screen * 2 };
}

/** Whether a card's box meets `span`. A card that only just crosses the
 *  edge still counts: half a poster is how a scroll should arrive. */
export function inWarmSpan(
  top: number,
  height: number,
  span: { top: number; bottom: number },
): boolean {
  return top + height > span.top && top < span.bottom;
}

/** Bottom breathing room, so Recenter never covers the last row. */
const BOTTOM_PAD = 90;

/** Extra room above a row whose year is more than one after the last. */
const GAP_MARK = 10;

export function layoutGrid(
  payload: GridPayload,
  width: number,
  settings: GridSettings = DEFAULT_SETTINGS,
  prior: GridLayout | null = null,
): GridLayout {
  const m = metricsFor(width, settings);
  // A later page of films must not slide cards the reader already saw.
  // Keep each known film's left and lane; only newcomers are packed, and
  // only into the space that is still free. A new map, or a width that
  // changes the axis, starts again.
  const held =
    prior &&
    prior.anchor?.film.id === payload.anchor.id &&
    samePlot(prior.metrics, m)
      ? new Map(prior.cards.map((c) => [c.film.id, c]))
      : new Map<number, Placed>();
  // The rating floor is not a filter, it is a highlight: every film the
  // page holds is laid out, and the floor only decides what is lit. The
  // unrated column is a different thing — turning it off takes a column
  // off the plot, so those films really do leave.
  const films = settings.showUnrated
    ? payload.films
    : payload.films.filter((f) => f.isAnchor || f.rating != null);

  const byYear = new Map<number, GridFilm[]>();
  for (const f of films) {
    const list = byYear.get(f.year);
    if (list) list.push(f);
    else byYear.set(f.year, [f]);
  }
  const years = [...byYear.keys()].sort((a, b) =>
    settings.yearOrder === 'newest' ? b - a : a - b,
  );

  const rows: Row[] = [];
  const cards: Placed[] = [];
  let top = 0;
  let previous: number | null = null;

  for (const year of years) {
    // A jump in the years is worth seeing, whichever way the rows run.
    if (previous !== null && Math.abs(year - previous) > 1) top += GAP_MARK;
    previous = year;

    const newerFirst = settings.yearOrder === 'newest';
    const inYear = [...byYear.get(year)!].sort(byDateThenTitle(newerFirst));
    const lanes: number[] = [];
    const placedHere: Placed[] = [];
    // Date order every time, so January sits above December. A card the
    // reader already saw keeps its left — only the lane may open up
    // when a month arrives between two others. That is a row growing,
    // not a card sliding to a different rating.
    for (const f of inYear) {
      const keep = held.get(f.id);
      const ideal =
        keep?.left ??
        (f.rating == null
          ? m.railW + 8
          : Math.round(xOf(f.rating, m) - m.cardW / 2));
      const { lane, left } = fitLane(lanes, ideal, m.cardW);
      const sit = keep && laneOpen(lanes, lane, keep.left) ? keep.left : left;
      occupy(lanes, lane, sit + m.cardW);
      placedHere.push({ film: f, left: sit, top: 0, lane });
    }

    const height = 12 + Math.max(lanes.length, 1) * (m.cardH + GAP) + 6;
    const rowTop = top;
    for (const p of placedHere) {
      cards.push({ ...p, top: rowTop + 12 + p.lane * (m.cardH + GAP) });
    }
    rows.push({
      year,
      top: rowTop,
      height,
      lanes: Math.max(lanes.length, 1),
      decade: year % 10 === 0,
      anchorYear: settings.highlightYear && year === payload.anchor.year,
      index: rows.length,
    });
    top += height;
  }

  return {
    metrics: m,
    rows,
    cards,
    lines: gridLines(m),
    plotW: m.plotW,
    plotH: top + BOTTOM_PAD,
    unratedEdge: m.railW + m.unratedW,
    anchor: cards.find((c) => c.film.isAnchor) ?? null,
  };
}

/** Whether a film clears the reader's rating floor. An unrated film
 *  clears no floor at all — there is nothing to compare — but with no
 *  floor asked for, everything is lit. */
export function passesFloor(rating: number | null, floor: number | null): boolean {
  if (floor == null) return true;
  return rating != null && rating >= floor;
}

/** Month and day inside the year, then title. Missing dates sit at
 *  the first of January so we do not invent a mid-year seat. */
export function dateOrd(f: GridFilm): number {
  const y = f.year || 0;
  let mo = 1;
  let d = 1;
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(f.released ?? '');
  if (m) {
    mo = Math.min(12, Math.max(1, Number(m[2]) || 1));
    d = m[3] ? Math.min(31, Math.max(1, Number(m[3]) || 1)) : 1;
  }
  return y * 10000 + mo * 100 + d;
}

function byDateThenTitle(newerFirst: boolean) {
  return (a: GridFilm, b: GridFilm): number => {
    const d = dateOrd(a) - dateOrd(b);
    if (d !== 0) return newerFirst ? -d : d;
    return a.title.localeCompare(b.title);
  };
}

/** The axis a card is measured against. If this is unchanged, a later
 *  page can keep every film where it already sat. */
function samePlot(a: Metrics, b: Metrics): boolean {
  return (
    a.cardW === b.cardW &&
    a.cardH === b.cardH &&
    a.left === b.left &&
    a.right === b.right &&
    a.plotW === b.plotW &&
    a.unratedW === b.unratedW
  );
}

/** Whether [left, left+cardW) sits to the right of everything already
 *  in this lane. Held cards are placed left-to-right, so this is enough. */
function laneOpen(lanes: number[], lane: number, left: number): boolean {
  return lane >= lanes.length || left >= lanes[lane] + GAP;
}

/** Mark a lane occupied up to `end`. Unused lanes stay "empty" so a new
 *  card can still drop into a hole instead of opening a row. */
function occupy(lanes: number[], lane: number, end: number): void {
  while (lanes.length <= lane) lanes.push(-GAP);
  lanes[lane] = Math.max(lanes[lane], end);
}

/** Finds a lane the card fits in at its honest x, or one it can reach with
 *  a nudge small enough that the card still reads at its own rating.
 *  Otherwise it opens a new lane and keeps x exactly. */
export function fitLane(
  lanes: number[],
  ideal: number,
  cardW: number,
): { lane: number; left: number } {
  const clear = lanes.findIndex((end) => ideal >= end + GAP);
  if (clear !== -1) return { lane: clear, left: ideal };

  const nudge = Math.round(cardW * NUDGE_RATIO);
  const near = lanes.findIndex((end) => end + GAP - ideal <= nudge);
  if (near !== -1) return { lane: near, left: lanes[near] + GAP };

  return { lane: lanes.length, left: ideal };
}

/** A people marker: 7px dot, 4px from its neighbour. */
export const DOT = 7;
export const MARKER_GAP = 4;

/** Room to reserve for the rating text at the other end of the row. */
const RATED_W = 24;
const UNRATED_W_TEXT = 54;

/** Room a "+3" needs. */
const PLUS_W = 22;

/** Room two initials badges need. */
const BADGE_W = 26;

export interface Markers {
  /** People to draw, in order. */
  show: number[];
  /** People there was no room for. */
  extra: number;
  /** Initials rather than dots, which only fit when there are one or two. */
  initials: boolean;
}

/** What a card can actually show of its people.
 *
 *  The spec assumed at most seven people on a film, because it capped the
 *  cast at five. With the whole cast there can be many more — eight of
 *  The Matrix's cast are in Reloaded — and a row of dots that does not fit
 *  is a row that gets clipped. So the card shows what fits and counts the
 *  rest. */
export function markersFor(people: number[], m: Metrics, rating: number | null): Markers {
  const none: Markers = { show: [], extra: 0, initials: false };
  if (people.length === 0) return none;

  // The poster takes the left of the card. What remains is the old text
  // column, padding included, which is what the rating and the markers share.
  const budget = m.cardW - m.posterW - 16 - (rating == null ? UNRATED_W_TEXT : RATED_W) - MARKER_GAP;
  if (people.length <= 2 && people.length * BADGE_W <= budget) {
    return { show: people, extra: 0, initials: true };
  }
  const per = DOT + MARKER_GAP;
  if (Math.floor(budget / per) >= people.length) {
    return { show: people, extra: 0, initials: false };
  }
  // Not everyone fits, so a count has to go on the end — and on a small
  // card an unrated film can leave no room even for that. The rating is
  // what the column is about, so it wins; the panel still names everyone.
  if (budget < PLUS_W) return none;
  const fit = Math.max(0, Math.floor((budget - PLUS_W) / per));
  return { show: people.slice(0, fit), extra: people.length - fit, initials: false };
}

/** The initials a card shows for one person: first letter of the first
 *  name and of the last, "KR" for Keanu Reeves.
 *
 *  The spec says a collision should take the first two letters of the
 *  last name, but the reference design's own people break that: Lana and
 *  Lilly Wachowski both give "LWA". Lengthening the *first* name is what
 *  actually tells them apart, so a collision grows "LaW" and "LiW", and
 *  keeps growing until the codes differ or the names run out. */
export function initialsFor(people: GridPerson[]): Map<number, string> {
  const codes = new Map<number, string>();
  for (const p of people) codes.set(p.id, initials(p.name, 1));
  for (let take = 2; take <= 4; take++) {
    const clashing = collisions(people, codes);
    if (clashing.size === 0) break;
    for (const p of people) {
      if (clashing.has(codes.get(p.id)!)) codes.set(p.id, initials(p.name, take));
    }
  }
  return codes;
}

/** The codes more than one person is using. */
function collisions(people: GridPerson[], codes: Map<number, string>): Set<string> {
  const count = new Map<string, number>();
  for (const p of people) {
    const code = codes.get(p.id)!;
    count.set(code, (count.get(code) ?? 0) + 1);
  }
  return new Set([...count].filter(([, n]) => n > 1).map(([code]) => code));
}

/** `take` letters of the first name, then one of the last. */
function initials(name: string, take: number): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0].slice(0, take);
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() + last.toUpperCase()).trim();
}
