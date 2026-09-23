// The rating grid.
//
// Y is the release year, as it has always been. X is the rating: low on
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
}

export interface GridFilm {
  id: number;
  title: string;
  year: number;
  rating: number | null;
  people: number[];
  isAnchor: boolean;
}

export interface GridPayload {
  anchor: GridFilm;
  people: GridPerson[];
  films: GridFilm[];
}

export interface GridSettings {
  density: 'comfortable' | 'compact';
  yearOrder: 'oldest' | 'newest';
  showUnrated: boolean;
  highlightYear: boolean;
}

export const DEFAULT_SETTINGS: GridSettings = {
  density: 'comfortable',
  yearOrder: 'oldest',
  showUnrated: true,
  highlightYear: true,
};

/** The rating domain is fixed rather than taken from the data, so the
 *  same rating sits in the same place on every map. */
export const R_LO = 3.5;
export const R_HI = 9.2;

/** Gap between cards, on both axes. */
export const GAP = 6;

/** Height of the sticky axis bar above the plot. */
export const AXIS_H = 30;

/** How far right a card may be nudged to join a lane before a new lane is
 *  opened. Beyond this the card would be lying about its rating. */
export const NUDGE_RATIO = 0.25;

export interface Metrics {
  phone: boolean;
  compact: boolean;
  cardW: number;
  cardH: number;
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
  const cardW = phone ? 92 : compact ? 96 : 116;
  const cardH = compact ? 46 : 68;
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

/** Bottom breathing room, so Recenter never covers the last row. */
const BOTTOM_PAD = 90;

/** Extra room above a row whose year is more than one after the last. */
const GAP_MARK = 10;

export function layoutGrid(
  payload: GridPayload,
  width: number,
  settings: GridSettings = DEFAULT_SETTINGS,
): GridLayout {
  const m = metricsFor(width, settings);
  const films = settings.showUnrated
    ? payload.films
    : payload.films.filter((f) => f.rating != null);

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

    const inYear = [...byYear.get(year)!].sort(byRatingThenTitle);
    const lanes: number[] = [];
    const placedHere: Placed[] = [];
    for (const f of inYear) {
      const ideal =
        f.rating == null
          ? m.railW + 8
          : Math.round(xOf(f.rating, m) - m.cardW / 2);
      const { lane, left } = fitLane(lanes, ideal, m.cardW);
      lanes[lane] = left + m.cardW;
      placedHere.push({ film: f, left, top: 0, lane });
    }

    const height = 12 + lanes.length * (m.cardH + GAP) + 6;
    const rowTop = top;
    for (const p of placedHere) {
      cards.push({ ...p, top: rowTop + 12 + p.lane * (m.cardH + GAP) });
    }
    rows.push({
      year,
      top: rowTop,
      height,
      lanes: lanes.length,
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

/** Unrated first, then by rating, so a row reads left to right. */
function byRatingThenTitle(a: GridFilm, b: GridFilm): number {
  if (a.rating == null && b.rating == null) return a.title.localeCompare(b.title);
  if (a.rating == null) return -1;
  if (b.rating == null) return 1;
  return a.rating - b.rating || a.title.localeCompare(b.title);
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

  const budget = m.cardW - 16 - (rating == null ? UNRATED_W_TEXT : RATED_W) - MARKER_GAP;
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
