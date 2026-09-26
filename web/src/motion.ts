// Every timing the app moves by, and the arithmetic behind the moves that
// need a measurement: where the opening's mark is drawn and where it
// flies, where a remapped card flies to and lands, how long each card
// and chip waits its turn. Kept apart from the components so each number
// is written once and can be checked without a DOM.

/** The five curves, as grid.css names them. Script-driven animations
 *  cannot read a custom property, so they take the same values from
 *  here; the stylesheet's tokens and these must agree (motion.test.ts
 *  checks that they do). */
export const EASE = {
  /** Most movement: flights, FLIP, the mark gliding home. */
  glide: 'cubic-bezier(0.22, 0.9, 0.24, 1)',
  /** Things arriving and coming to rest: posters, tiles. */
  settle: 'cubic-bezier(0.16, 1, 0.3, 1)',
  /** Sheets and panels leaving. */
  exit: 'cubic-bezier(0.4, 0, 0.8, 0.4)',
  /** Cards spreading out from the searched film. */
  spread: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  /** The opening mark coming into focus. */
  focus: 'cubic-bezier(0.25, 0.7, 0.2, 1)',
} as const;

/** A box in viewport pixels: what getBoundingClientRect gives, and all
 *  of it the maths here reads. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A point in viewport pixels. */
export interface Spot {
  x: number;
  y: number;
}

/** Whether the reader has asked for nothing to move, read at the moment
 *  it is asked. A stylesheet's reduced-motion rules do not reach an
 *  animation started from script, so every one of those asks this. */
export function stillNow(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Element.animate, for a reader who has not asked for stillness and a
 *  browser that has it. Null otherwise, and the caller carries on with
 *  the end state: nothing here is needed for the page to be right, only
 *  for it to arrive nicely. */
export function animate(
  el: Element | null | undefined,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
): Animation | null {
  if (!el || typeof el.animate !== 'function' || stillNow()) return null;
  try {
    return el.animate(keyframes, options);
  } catch {
    return null;
  }
}

// ---- the opening ("focus pull") ----
//
// Every time below is measured from the moment the frames are on screen,
// which is when the opening screen mounts.

/** A list already in hand by then. There is nothing to wait for, so
 *  there is nothing to show waiting: the header is simply complete. */
export const FAST_PATH_MS = 120;

/** The headline, the sub-line and the theme picker each fade in over
 *  this, one step apart, from the start. Linear, as the design's own
 *  fade is: an eased fade on type reads as a pop and then a shimmer. */
export const COPY_FADE_MS = 600;
export const COPY_STEP_MS = 120;

/** The veil: the page under the header dims while the mark comes into
 *  focus over it, and comes back up as the mark leaves. */
export const VEIL_OPACITY = 0.72;
export const VEIL_IN_MS = 420;
export const VEIL_OUT_MS = 600;
/** The veil starts to rise once a fast list has been ruled out, not at
 *  0 as the design has it. The design also skips the whole sequence for
 *  a list in hand within FAST_PATH_MS, and both cannot hold: a veil
 *  raised at 0 is already a third of the way down by then, and a fast
 *  load would dim the page and bring it back for nothing. The mark is
 *  still invisible until FOCUS_DELAY_MS, and the veil is fully down well
 *  before the focus settles. */
export const VEIL_AT_MS = FAST_PATH_MS;

/** The mark's size while it is drawn over the tiles (the header's is
 *  Wordmark.tsx's MARK_W × MARK_H). */
export const LOADER_W = 46;
export const LOADER_H = 70;
/** The lowest the mark's centre sits: clear of the bottom of a short
 *  window, whatever the tiles below it are doing. */
export const LOADER_FLOOR = 48;

/** The mark racks into focus like a projector finding the screen: past
 *  sharp, a slight hunt back, then settled. One curve over the whole
 *  thing, not one per step, which is why it is played from script
 *  rather than as a stylesheet keyframe. */
export const FOCUS_DELAY_MS = 140;
export const FOCUS_MS = 920;
export const FOCUS_END_MS = FOCUS_DELAY_MS + FOCUS_MS;
export const FOCUS_KEYFRAMES: Keyframe[] = [
  { opacity: 0, filter: 'blur(14px)', transform: 'scale(1.45)' },
  { opacity: 1, filter: 'blur(0px)', transform: 'scale(0.985)', offset: 0.62 },
  { filter: 'blur(1.2px)', transform: 'scale(1.006)', offset: 0.8 },
  { opacity: 1, filter: 'blur(0px)', transform: 'scale(1)' },
];

/** While a slow list keeps it waiting, the focus breathes: in and out
 *  of true, over and over, until the list lands. It starts just after
 *  the focus has settled, if the list is still out then; the app cannot
 *  know in advance that it will be slow. */
export const BREATHE_AT_MS = 1120;
export const BREATHE_MS = 1600;
export const BREATHE_BLUR_PX = 1.8;

/** The glide into the header, and the softening the mark goes through
 *  on the way (sharpest at either end, a touch soft at 40%). */
export const GLIDE_MS = 520;
export const GLIDE_BLUR_PX = 1.4;
/** The posters start just after the mark lifts off, so the two are
 *  never drawn in the same pixels. */
export const TILES_AFTER_LIFT_MS = 80;
/** "inedikt" comes into focus just before its C lands. */
export const WORD_BEFORE_LANDING_MS = 200;
export const WORD_MS = 440;

/** Each poster comes into focus in reading order: its fill over
 *  TILE_FILL_MS, its caption over TILE_CAPTION_MS a little behind. The
 *  stylesheet draws these from the same numbers (.cd-cold-fill). */
export const TILE_FILL_MS = 640;
export const TILE_FILL_DELAY_MS = 20;
export const TILE_CAPTION_MS = 400;
export const TILE_CAPTION_DELAY_MS = 110;
export const TILE_STEP_MS = 70;

export function tileFillDelay(i: number): number {
  return TILE_FILL_DELAY_MS + i * TILE_STEP_MS;
}

export function tileCaptionDelay(i: number): number {
  return TILE_CAPTION_DELAY_MS + i * TILE_STEP_MS;
}

/** Coming back to the opening screen from a map does not replay the
 *  opening. The tiles rise into place instead, in reading order. */
export const RETURN_TILE_MS = 420;
export const RETURN_TILE_DELAY_MS = 80;
export const RETURN_TILE_STEP_MS = 45;
export const RETURN_RISE_PX = 10;

export function returnTileDelay(i: number): number {
  return RETURN_TILE_DELAY_MS + i * RETURN_TILE_STEP_MS;
}

/** When each part of the opening happens, for a list that arrived at
 *  `listAt`. `fast` means none of it does. */
export interface OpeningPlan {
  fast: boolean;
  /** The focus is let run to the end even for a quick list: cutting a
   *  mark loose while it is still blurred is worse than the wait. */
  lift: number;
  /** Whether the list was still out when the focus settled. */
  breathes: boolean;
  tilesIn: number;
  word: number;
  /** The loader goes and the header's own mark appears. */
  done: number;
}

export function openingPlan(listAt: number): OpeningPlan {
  const lift = Math.max(listAt, FOCUS_END_MS);
  return {
    fast: listAt < FAST_PATH_MS,
    lift,
    breathes: listAt > BREATHE_AT_MS,
    tilesIn: lift + TILES_AFTER_LIFT_MS,
    word: lift + GLIDE_MS - WORD_BEFORE_LANDING_MS,
    done: lift + GLIDE_MS,
  };
}

/** Where the mark comes into focus: centred across the tile grid, and
 *  halfway down the part of it the reader can see, from the first frame
 *  to the grid's bottom or the window's, whichever comes first. Never
 *  so low that it sits on the bottom edge.
 *
 *  Null when the frames have no size — a page nobody is painting, such
 *  as one opened in a background tab — and the opening is skipped. */
export function loaderSpot(grid: Box, frame: Box, vh: number): Spot | null {
  if (!(frame.height > 0)) return null;
  const top = Math.max(grid.top, frame.top);
  const bottom = Math.min(grid.top + grid.height, vh);
  return {
    x: grid.left + grid.width / 2,
    y: Math.min((top + bottom) / 2, vh - LOADER_FLOOR),
  };
}

/** The trip from the tiles to the header's slot: centre to centre, and
 *  shrinking to the slot's width on the way. */
export function markFlight(slot: Box, from: Spot): { dx: number; dy: number; scale: number } {
  return {
    dx: slot.left + slot.width / 2 - from.x,
    dy: slot.top + slot.height / 2 - from.y,
    scale: slot.width / LOADER_W,
  };
}

// ---- opening a map ----

/** The map being left fades out over this while the next is fetched. A
 *  map already in hand switches at once: there is no wait to cover. */
export const MAP_FADE_MS = 220;

/** Every card but the searched one arrives from a little below and a
 *  little small, waiting for its distance from the searched film (see
 *  revealDelay in grid.ts). */
export const SPREAD_MS = 460;
export const SPREAD_RISE_PX = 12;
export const SPREAD_SCALE = 0.96;

/** The axis bar, the year bands and their labels fade in with it. */
export const AXIS_FADE_MS = 280;

/** The map is laid out first and let go a moment later, so every card
 *  has a painted state to travel out of. */
export const REVEAL_FLIP_MS = 30;
/** How long the spread stays open after that: the longest wait plus
 *  the spread itself, with a frame to spare. A card that dims after it
 *  closes does so at once, with no ripple behind it. */
export const REVEAL_WINDOW_MS = 1000;

/** The window for a map that opens `after` ms late, as one landing a
 *  flown card does. */
export function revealWindow(after: number): number {
  return after + REVEAL_WINDOW_MS;
}

// ---- moving between maps ----

/** The card tapped in the sheet rises and the rest of the map dims. */
export const LIFT_MS = 240;
/** A copy of it flies to the middle of the map and grows a little. */
export const FLY_MS = 380;
export const FLY_SCALE = 1.14;
/** The next map is set this long after the flight starts. */
export const SET_AT_MS = 560;
/** The copy lands on the new searched card. */
export const LAND_MS = 320;
/** The rest of the new map spreads from it this much later than a map
 *  opened any other way. */
export const SPREAD_AFTER_LANDING_MS = 220;

/** How far the flying copy moves: from the card to the middle of the
 *  map the reader can see, which on a phone starts under the header
 *  lying over it (`over` pixels of the scroller's top). */
export function flightTo(card: Box, scroller: Box, over: number): { tx: number; ty: number } {
  return {
    tx: scroller.left + scroller.width / 2 - (card.left + card.width / 2),
    ty: scroller.top + over + (scroller.height - over) / 2 - (card.top + card.height / 2),
  };
}

/** The landing: from where the copy started to exactly where the new
 *  searched card is, centre to centre, and stretched to its size. The
 *  new card can be a different size — the window may have crossed a
 *  screen class — so the two axes scale apart. */
export function landingTransform(
  from: Box,
  to: Box,
): { tx: number; ty: number; sx: number; sy: number } {
  return {
    tx: to.left + to.width / 2 - (from.left + from.width / 2),
    ty: to.top + to.height / 2 - (from.top + from.height / 2),
    sx: from.width > 0 ? to.width / from.width : 1,
    sy: from.height > 0 ? to.height / from.height : 1,
  };
}

/** The chip row after a move: a chip both maps share slides from where
 *  it was to where it is now; a new one rises in after them, one short
 *  step behind the one before it. */
export const CHIP_FLIP_MS = 420;
export const CHIP_IN_MS = 260;
export const CHIP_IN_DELAY_MS = 260;
export const CHIP_IN_STEP_MS = 35;
export const CHIP_IN_RISE_PX = 6;

export function chipInDelay(k: number): number {
  return CHIP_IN_DELAY_MS + k * CHIP_IN_STEP_MS;
}

/** How far back to put a chip so it starts where it used to be. */
export function chipShift(was: Box, now: Box): { dx: number; dy: number } {
  return { dx: was.left - now.left, dy: was.top - now.top };
}

// ---- narrowing the map ----

/** Hiding or showing the empty years. Cards that stay glide to their
 *  new rows; cards that arrive fade in a moment behind them, to their
 *  own opacity; cards that leave fade where they were. */
export const REFLOW_MS = 260;
export const ARRIVE_MS = 220;
export const ARRIVE_DELAY_MS = 60;
export const GHOST_MS = 140;
/** One painted frame: long enough for a mounted "from" state to be on
 *  screen, which is what a transition needs to travel out of. */
export const FLIP_MS = 30;
