/** Ease-in-out cubic: slow start, long slide, gentle stop. */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (2 - 2 * t) ** 3 / 2;
}

/** Longer hops take longer, but stay in a range that still feels like one gesture. */
export function glideDurationMs(dx: number, dy: number): number {
  return Math.round(Math.min(1400, Math.max(560, 420 + Math.hypot(dx, dy) * 0.38)));
}

/** Extra frames at the destination so a trailing layout shift cannot knock
 *  the camera off the film the moment the ease finishes. */
export const GLIDE_SETTLE_MS = 200;
