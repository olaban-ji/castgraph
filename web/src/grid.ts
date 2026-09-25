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
  /** An IMDb name id, such as nm0000206. */
  id: string;
  name: string;
  role: 'cast' | 'director';
  character?: string;
  order: number;
  /** How many of this person's films belong on the grid, career-wide. */
  count?: number;
}

/** Where a card goes and whose it is, and nothing else. The server
 *  sends the whole spine at once, so the layout is final from the first
 *  paint and no card ever moves again. */
export type SpineTuple = [
  id: string,
  year: number,
  rating: number | null,
  /** Month and day as MMDD, 0 when the date says only a year. */
  md: number,
  /** Who of the chip row is on this film, as indexes into
   *  `payload.people`. Indexes rather than name ids, because there are
   *  four hundred films and the ids would be most of the payload. */
  people?: number[],
];

export interface SpineFilm {
  /** An IMDb title id, such as tt0133093. */
  id: string;
  year: number;
  rating: number | null;
  /** Month and day as MMDD. Cards stacked in one year sit in calendar
   *  order; the year is already the row, so nothing else is needed. */
  md: number;
  /** Places in the chip row. It is on the spine rather than only in the
   *  detail so that a row can be judged before anybody has scrolled to
   *  it: hiding the empty years asks of every year whether anything in
   *  it is lit, including the years nobody has looked at yet. */
  people: number[];
  isAnchor: boolean;
}

/** What a card says, which arrives a screen at a time into a box that
 *  already exists. Its people are name ids, not spine indexes: the card
 *  draws a marker per person and looks each one up by id. */
export interface GridFilm extends Omit<SpineFilm, 'people'> {
  title: string;
  /** YYYY-MM-DD when we have it. The year band stacks by this, not labels. */
  released?: string;
  poster?: string;
  people: string[];
}

/** What the server sends: the searched film, its people, and the spine. */
export interface GridPayload {
  anchor: GridFilm;
  people: GridPerson[];
  films: SpineTuple[];
  /** The stamp on this movie's share image, so the client can ask for
   *  it while the map opens rather than leaving the first reader to
   *  paste a link at an address that has nothing behind it yet. */
  og_v?: string;
}

/** The spine, read into something with names on it. */
export function spineOf(payload: GridPayload): SpineFilm[] {
  return payload.films.map(([id, year, rating, md, people]) => ({
    id,
    year,
    rating,
    md: md ?? 0,
    people: people ?? [],
    isAnchor: id === payload.anchor.id,
  }));
}

/** The oldest and newest years this map holds. The year control's ends
 *  are the map's own, so a reader is never offered a decade the cast
 *  never worked in. */
export function yearBounds(payload: GridPayload): { lo: number; hi: number } {
  let lo = payload.anchor.year;
  let hi = payload.anchor.year;
  for (const [, year] of payload.films) {
    if (!year) continue;
    if (year < lo) lo = year;
    if (year > hi) hi = year;
  }
  return { lo, hi };
}

export interface GridSettings {
  yearOrder: 'oldest' | 'newest';
  showUnrated: boolean;
  highlightYear: boolean;
  /** Dim anything rated below this. Null lights everything. It never
   *  removes a card: the grid's whole argument is where a film sits on
   *  the scale, and a film that leaves the page cannot make it. */
  minRating: number | null;
  /** Inclusive; null is open on that side.
   *
   *  Years are the rows themselves, so cropping them takes nothing away
   *  from what the grid is claiming — unlike the rating floor, where a
   *  film's place on the scale is the whole point and removing it would
   *  be removing the argument.
   *
   *  Absolute years, not an offset from the searched film. The range
   *  belongs to the visit it was set on: another movie starts clear,
   *  and coming back restores it. */
  yearFrom: number | null;
  yearTo: number | null;
  /** Collapse rows where nothing is lit. Applies to every filter. */
  hideEmptyYears: boolean;
}

export const DEFAULT_SETTINGS: GridSettings = {
  yearOrder: 'oldest',
  showUnrated: true,
  highlightYear: true,
  minRating: null,
  yearFrom: null,
  yearTo: null,
  hideEmptyYears: false,
};

/** Settings a stored string, read back. Anything missing takes its
 *  default, and anything the app no longer has is dropped rather than
 *  carried: an install from before Compact cards was removed still has
 *  `density` in its JSON, and spreading that back would put a dead
 *  setting into every object written from then on.
 *
 *  A string rather than the storage itself, so it can be tested without
 *  one and so a blocked localStorage is the caller's problem. */
export function settingsFrom(raw: string | null): GridSettings {
  if (!raw) return DEFAULT_SETTINGS;
  let stored: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_SETTINGS;
    stored = { ...(parsed as Record<string, unknown>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
  for (const gone of RETIRED) delete stored[gone];
  return { ...DEFAULT_SETTINGS, ...stored } as GridSettings;
}

/** Settings that used to exist. */
const RETIRED = ['density'];

/** The rungs the rating filter offers. Whole and half points, because a
 *  reader thinks in "at least a seven", not in decimals. */
export const RATING_STOPS = [6, 6.5, 7, 7.5, 8, 8.5] as const;

/** The rating domain is fixed rather than taken from the data, so the
 *  same rating sits in the same place on every map. */
export const R_LO = 3.5;
export const R_HI = 9.2;

/** Gap between cards, on both axes. */
export const GAP = 6;

/** The height of the rating strip along the top of the plot. The rows
 *  start this far down, and the strip is pulled back over them with a
 *  negative margin so the bands and cards slide underneath it rather
 *  than stopping at a gutter.
 *
 *  It used to be zero, on the theory that the gridlines say the rating
 *  by themselves. They do not once the map has been panned sideways —
 *  which on a phone is the only way to reach the high end at all. */
export const AXIS_H = 22;

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
  // A phone's card is the narrow one. There used to be a switch for
  // this, which on a phone changed nothing — the card was already
  // compact — and on a desktop clamped titles to a single line, so most
  // of them ended in an ellipsis. A control whose only effect is to
  // hide the names is not a preference.
  const compact = phone;
  // The poster sits beside the title. Its width is extra: the text column
  // stays the size the markers were measured against.
  const posterW = phone ? 40 : 52;
  const posterH = Math.round(posterW * 1.5);
  const cardW = (phone ? 92 : 116) + posterW;
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
    // Two lines everywhere. Even the phone's card has room: the title
    // sits beside a 60px poster and two lines of 12.5px at 1.18 come to
    // 29.5px.
    titleLines: 2,
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
  film: SpineFilm;
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
  /** The gap between the searched film's row and the range the reader
   *  asked for, when the two are not next to each other. It holds no
   *  cards and carries no year: it is the years that are missing. */
  isBreak?: boolean;
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

/** Bottom breathing room, so the last row can always be scrolled clear
 *  of the floating buttons rather than sitting under them. */
const BOTTOM_PAD = 110;

/** Extra room above a row whose year is more than one after the last. */
const GAP_MARK = 10;

/** The height of the break row between the searched film and a year
 *  range that does not hold it. */
export const BREAK_H = 28;

/** Whether a year is inside the reader's range. Either end may be open,
 *  and both open is no range at all. */
export function inYearRange(year: number, settings: GridSettings): boolean {
  if (settings.yearFrom != null && year < settings.yearFrom) return false;
  if (settings.yearTo != null && year > settings.yearTo) return false;
  return true;
}

/** Whether a film is lit by what the reader has asked for.
 *
 *  The searched film always is: it is the centre of its own map. An
 *  unrated film clears no floor, because there is nothing to compare;
 *  with nobody selected, everyone counts.
 *
 *  A hovered chip is not part of this. A preview that reflowed the grid
 *  would move the cards out from under the pointer that asked for it. */
export function isLit(
  f: SpineFilm,
  selected: Set<number>,
  floor: number | null,
): boolean {
  if (f.isAnchor) return true;
  if (!passesFloor(f.rating, floor)) return false;
  if (selected.size === 0) return true;
  return f.people.some((i) => selected.has(i));
}

export function layoutGrid(
  payload: GridPayload,
  width: number,
  settings: GridSettings = DEFAULT_SETTINGS,
  /** What counts as lit, for `hideEmptyYears`. Without it nothing is
   *  hidden, whatever the setting says — a caller that cannot judge a
   *  film should not be collapsing rows on a guess. */
  lit?: (f: SpineFilm) => boolean,
): GridLayout {
  const m = metricsFor(width, settings);
  // The rating floor is not a filter, it is a highlight: every film the
  // page holds is laid out, and the floor only decides what is lit. The
  // unrated column is a different thing — turning it off takes a column
  // off the plot, so those films really do leave.
  const spine = spineOf(payload);
  let films = settings.showUnrated
    ? spine
    : spine.filter((f) => f.isAnchor || f.rating != null);

  // The crop. Rows outside the range are removed rather than dimmed,
  // the same way the unrated column leaves when it is turned off. The
  // searched film is never cropped: a map without the movie it is of is
  // not a shorter map, it is a different one.
  films = films.filter((f) => f.isAnchor || inYearRange(f.year, settings));
  if (settings.hideEmptyYears && lit) {
    films = films.filter((f) => f.isAnchor || lit(f));
  }

  const byYear = new Map<number, SpineFilm[]>();
  for (const f of films) {
    const list = byYear.get(f.year);
    if (list) list.push(f);
    else byYear.set(f.year, [f]);
  }
  const years = [...byYear.keys()].sort((a, b) =>
    settings.yearOrder === 'newest' ? b - a : a - b,
  );
  // Where the searched film's year sits apart from the range, if it
  // does. It is at one end of the list, because a range is contiguous
  // and the anchor's year is outside it on one side or the other.
  const orphan =
    years.length > 1 &&
    payload.anchor.year > 0 &&
    !inYearRange(payload.anchor.year, settings)
      ? payload.anchor.year
      : null;

  const rows: Row[] = [];
  const cards: Placed[] = [];
  // Below the rating strip, which is pinned to the top of the scroller.
  let top = AXIS_H;
  let previous: number | null = null;

  for (const year of years) {
    // The gap the crop left, said in one row rather than by a number
    // the reader has to work out from two years that do not meet.
    // Either side: the searched film's row comes first when the rows
    // run oldest first and its year is below the range, and last when
    // they run the other way.
    if (orphan !== null && previous !== null && (year === orphan || previous === orphan)) {
      rows.push({
        year: 0,
        top,
        height: BREAK_H,
        lanes: 0,
        decade: false,
        anchorYear: false,
        index: rows.length,
        isBreak: true,
      });
      top += BREAK_H;
      // The break stands in for the jump, so the jump mark would be
      // saying the same thing twice.
      previous = year;
    }
    // A jump in the years is worth seeing, whichever way the rows run.
    if (previous !== null && Math.abs(year - previous) > 1) top += GAP_MARK;
    previous = year;

    // The whole axis runs one way. If the newest year is at the top,
    // the newest month inside it is too: otherwise time would run
    // backwards between years and forwards inside them.
    const inYear = [...byYear.get(year)!].sort(byDateThenId(settings.yearOrder === 'newest'));
    const lanes: number[] = [];
    const placedHere: Placed[] = [];
    // Date order, so January sits above December — and it holds for the
    // whole row, not only for cards that happen to collide. A card may
    // never take a lane above the one before it, which is what makes the
    // vertical position inside a year mean something. Every film the grid
    // holds is here already — that is what the spine is for — so a card
    // is placed once and there is never a later arrival to make room for.
    let floor = 0;
    for (const f of inYear) {
      const ideal =
        f.rating == null
          ? m.railW + 8
          : Math.round(xOf(f.rating, m) - m.cardW / 2);
      const { lane, left } = fitLane(lanes, ideal, m.cardW, floor);
      lanes[lane] = left + m.cardW;
      floor = lane;
      placedHere.push({ film: f, left, top: 0, lane });
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

/** What the reader has narrowed the map with, said in the header.
 *
 *  Nothing that hides content may be invisible: a year range or a
 *  collapsed empty year has to be named, or a map with rows gone
 *  looks broken.
 *
 *  The rating floor is only named here when the rungs are not in the
 *  header — on a desktop they already say it, and saying it twice is
 *  noise. The empty string means nothing is narrowed and there is no
 *  pill to draw. */
export function activeFilters(settings: GridSettings, rungsInView: boolean): string {
  const parts: string[] = [];
  if (rungsInView && settings.minRating != null) {
    parts.push(`${settings.minRating.toFixed(1)}+`);
  }
  const { yearFrom: from, yearTo: to } = settings;
  if (from != null && to != null) parts.push(`${from}–${to}`);
  else if (from != null) parts.push(`From ${from}`);
  else if (to != null) parts.push(`To ${to}`);
  // Hiding the empty years is not here. It filters no movie out — it
  // only closes up the rows between the ones already showing — and the
  // reader can see it has happened. A pill is for what is hidden.
  return parts.join(' · ');
}

/** How many settings differ from the defaults, for the View button.
 *
 *  A range counts once however many ends it has: the reader set one
 *  thing. The rating floor counts only where it is changed from — in
 *  the panel — so the number matches what opening the panel would show.
 */
export function changedCount(settings: GridSettings, rungsInView: boolean): number {
  let n = 0;
  if (settings.yearOrder !== DEFAULT_SETTINGS.yearOrder) n++;
  if (settings.showUnrated !== DEFAULT_SETTINGS.showUnrated) n++;
  if (settings.highlightYear !== DEFAULT_SETTINGS.highlightYear) n++;
  if (settings.yearFrom != null || settings.yearTo != null) n++;
  if (rungsInView && settings.minRating != null) n++;
  return n;
}

/** Whether a film clears the reader's rating floor. An unrated film
 *  clears no floor at all — there is nothing to compare — but with no
 *  floor asked for, everything is lit. */
export function passesFloor(rating: number | null, floor: number | null): boolean {
  if (floor == null) return true;
  return rating != null && rating >= floor;
}

/** Where a card sits inside its year. The spine carries the month and
 *  day as MMDD; a film whose date says only a year sits at the head of
 *  it, which is where an unknown month belongs. */
export function dateOrd(f: Pick<SpineFilm, 'year' | 'md'>): number {
  const md = f.md > 0 ? f.md : 101;
  return (f.year || 0) * 10000 + md;
}

/** Date order, then id. The spine has no titles — that is the point of
 *  it — so the tiebreak is the id, which is stable and does not change
 *  when the detail for a card arrives.
 *
 *  It follows the year axis: with the newest year at the top, the
 *  newest month in that year is at the top of it too, so time runs one
 *  way down the whole page. */
function byDateThenId(newerFirst: boolean) {
  return (a: SpineFilm, b: SpineFilm): number => {
    const d = dateOrd(a) - dateOrd(b);
    if (d !== 0) return newerFirst ? -d : d;
    // Two films of the same day still need one order, and an IMDb id is
    // roughly the order the record was made, which is as good a
    // tiebreak as any and is stable between renders.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}




/** Finds a lane the card fits in at its honest x, or one it can reach with
 *  a nudge small enough that the card still reads at its own rating.
 *  Otherwise it opens a new lane and keeps x exactly. */
export function fitLane(
  lanes: number[],
  ideal: number,
  cardW: number,
  /** The lowest lane this card may take. Films are placed in date order,
   *  so passing the previous card's lane keeps the row reading top to
   *  bottom as January to December. Without it a card with a distinctive
   *  rating drops into an early lane and sits above films from months
   *  before it — an order the row appears to have and does not. */
  from = 0,
): { lane: number; left: number } {
  for (let i = from; i < lanes.length; i++) {
    if (ideal >= lanes[i] + GAP) return { lane: i, left: ideal };
  }
  const nudge = Math.round(cardW * NUDGE_RATIO);
  for (let i = from; i < lanes.length; i++) {
    if (lanes[i] + GAP - ideal <= nudge) return { lane: i, left: lanes[i] + GAP };
  }
  return { lane: lanes.length, left: ideal };
}

/** Whether a rating floor has left a lone selected person with nothing
 *  lit. The searched film always stays lit and is not part of the answer,
 *  and a person we know nothing about yet is not claimed either.
 *
 *  Judged over the films whose detail has arrived, which is the same
 *  ground the dimming itself stands on: a card whose people are still
 *  unknown is given the benefit of the doubt and stays lit. */
export function nothingLit(
  detail: Iterable<GridFilm>,
  person: string,
  floor: number,
): boolean {
  let theirs = false;
  for (const film of detail) {
    if (film.isAnchor || !film.people.includes(person)) continue;
    theirs = true;
    if (passesFloor(film.rating, floor)) return false;
  }
  return theirs;
}

/** The longest a card ever waits to appear, and how much of its
 *  distance from the searched film it waits for. */
export const REVEAL_MAX_MS = 520;
const REVEAL_PER_PX = 0.35;

/** How long a card waits before it appears, so the map opens outward
 *  from the film that was searched for rather than all at once.
 *
 *  Every card is the same size, so the gap between two cards' corners is
 *  the gap between their centres. */
export function revealDelay(card: Placed, anchor: Placed | null): number {
  if (!anchor || card.film.isAnchor) return 0;
  const d = Math.hypot(card.left - anchor.left, card.top - anchor.top);
  return Math.min(REVEAL_MAX_MS, Math.round(d * REVEAL_PER_PX));
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
  show: string[];
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
export function markersFor(people: string[], m: Metrics, rating: number | null): Markers {
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
export function initialsFor(people: GridPerson[]): Map<string, string> {
  const codes = new Map<string, string>();
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
function collisions(people: GridPerson[], codes: Map<string, string>): Set<string> {
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
