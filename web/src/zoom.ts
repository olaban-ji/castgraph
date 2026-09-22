import { HEADER_H, type Geometry } from './layout';

export const ZOOM_MIN = 0.4;
export const ZOOM_MAX = 1.6;
/** One click of the + / − buttons. */
export const ZOOM_STEP = 1.15;
/** Default view is this many − clicks looser than a tight fit. A first
 *  screen with a dozen readable films beats one with forty unreadable ones. */
export const FIT_OUT_STEPS = 1;

/** Years of timeline that should fill the window below the header. */
export const YEARS_IN_VIEW = 15;
/** Branch spreads that should fill the window width. */
export const SPREADS_IN_VIEW = 5;
/** Floor so cards stay readable on a narrow screen. */
export const MIN_ANCHOR_PX = 160;
/** Pinch/ctrl-wheel: smaller = slower. */
export const WHEEL_ZOOM_SENSITIVITY = 0.0026;

export function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/** Zoom that covers a similar neighbourhood of the map on any screen,
 *  then two button-clicks zoomed out from that tight fit. */
export function fitZoom(vw: number, vh: number, g: Geometry): number {
  const usableH = Math.max(1, vh - HEADER_H);
  const byYears = usableH / (g.ppy * YEARS_IN_VIEW);
  const bySpread = vw / (g.spread * SPREADS_IN_VIEW);
  const byCard = MIN_ANCHOR_PX / g.anchor[0];
  const tight = Math.max(byCard, Math.min(byYears, bySpread));
  return clampZoom(tight / ZOOM_STEP ** FIT_OUT_STEPS);
}

/** Smallest rendered text the map will show, in CSS pixels. Below this a
 *  label is decoration, not information. */
export const MIN_TEXT_PX = 12;

/** How far text may be counter-scaled against the zoom before it would
 *  outgrow its card. Past this the card drops its metadata row instead. */
export const MAX_TEXT_COUNTER_SCALE = 1.6;

/** Font size for a nominal `px` at this zoom and card scale: shrink with
 *  the geometry until the result would fall under MIN_TEXT_PX, then stop.
 *  Posters carry the zoom; labels stay legible. */
export function fontPx(px: number, cardScale: number, zoom: number): number {
  const floor = Math.min(MIN_TEXT_PX / Math.max(zoom, 0.01), MIN_TEXT_PX * MAX_TEXT_COUNTER_SCALE);
  return Math.max(floor, px * cardScale);
}

/** True once text is being counter-scaled to its cap, where a card has
 *  room for a title and nothing else. */
export function textIsCapped(zoom: number): boolean {
  return MIN_TEXT_PX / Math.max(zoom, 0.01) >= MIN_TEXT_PX * MAX_TEXT_COUNTER_SCALE;
}

/** Zoom factor for a two-pointer pinch: the ratio of the current finger
 *  distance to the distance when the gesture began. Safari has
 *  `gesturechange`; every other touch browser has to be given this. */
export function pinchScale(startDistance: number, distance: number): number {
  if (startDistance < 1) return 1;
  return distance / startDistance;
}

export function pointerDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function wheelDeltaPx(deltaY: number, deltaMode: number): number {
  if (deltaMode === 1) return deltaY * 16;
  if (deltaMode === 2) return deltaY * 800;
  return deltaY;
}

export function zoomAfterWheel(
  current: number,
  deltaY: number,
  deltaMode = 0,
): number {
  return clampZoom(
    current * Math.exp(-wheelDeltaPx(deltaY, deltaMode) * WHEEL_ZOOM_SENSITIVITY),
  );
}
