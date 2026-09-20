import { HEADER_H, type Geometry } from './layout';

export const ZOOM_MIN = 0.4;
export const ZOOM_MAX = 1.6;
/** One click of the + / − buttons. */
export const ZOOM_STEP = 1.15;
/** Default view is this many − clicks looser than a tight fit. */
export const FIT_OUT_STEPS = 2;

/** Years of timeline that should fill the window below the header. */
export const YEARS_IN_VIEW = 21;
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
