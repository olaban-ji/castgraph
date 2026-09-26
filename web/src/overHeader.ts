import { useEffect, useState, type RefObject } from 'react';

/** How far the reader has to move before the header takes the hint. Less
 *  than this and a thumb resting on the glass would flap it. */
export const HEADER_SLOP = 6;

/** How far down the map the reader has to be before going further down
 *  hides the header. Above it the header stays: hiding it here would
 *  take the top of the map up with it for a scroll of a few rows. */
export const HIDE_AFTER = 80;

/** Within this much of the top the header is always shown, however the
 *  reader got there. */
export const SHOW_WITHIN = 40;

/** Whether the header should be out of the way, given where the reader
 *  was and where they are now. `null` means leave it as it is.
 *
 *  Going down more than the slop, once past HIDE_AFTER, hides it. Coming
 *  back up more than the slop shows it, and so does being near the top.
 *  `from` is where the last decision was taken, not the last event, so a
 *  slow scroll adds up: six one-pixel steps are a scroll of six. */
export function headerGoes(from: number, to: number): boolean | null {
  if (to < SHOW_WITHIN) return false;
  const moved = to - from;
  if (moved > HEADER_SLOP && to > HIDE_AFTER) return true;
  if (moved < -HEADER_SLOP) return false;
  return null;
}

/** A scroll the app is making by its own hand: centring a new map,
 *  Recenter, a card pinned in place under rows that came or went.
 *
 *  A scroll event cannot say who scrolled, so the app marks a window of
 *  time before it moves the map, and the header ignores the scroll
 *  events inside it. Without this the app's own movement reads as the
 *  reader travelling down the years, and the header they just tapped
 *  slides away from under them. */
export interface AppScroll {
  /** Scroll events before this moment are the app's. */
  until: number;
  /** The furthest `until` can be pushed out to by a scroll that is still
   *  running (see quietAt). */
  limit: number;
}

export const NO_APP_SCROLL: AppScroll = { until: 0, limit: 0 };

/** How long each kind of app scroll is given. An instant jump fires its
 *  event within a frame or two; a smooth one glides for most of a second. */
export const APP_SCROLL_MS = { smooth: 700, instant: 120 } as const;

/** A smooth scroll can outrun its window: its length is the browser's to
 *  choose, and grows with the distance. Each event inside the window
 *  pushes it this far past itself, so the window lasts as long as the
 *  glide does and closes this long after its last frame. */
export const APP_SCROLL_TAIL_MS = 120;

/** The longest one smooth scroll is waited out. A reader who grabs the
 *  map mid-glide makes scroll events too, and those must not hold the
 *  window open for as long as they keep moving. */
export const APP_SCROLL_LIMIT_MS = 1600;

/** The window for a scroll the app starts at `now`. `smooth` is whether
 *  it really glides: with reduced motion asked for, it jumps. */
export function appScrollAt(now: number, smooth: boolean): AppScroll {
  const until = now + (smooth ? APP_SCROLL_MS.smooth : APP_SCROLL_MS.instant);
  return { until, limit: smooth ? now + APP_SCROLL_LIMIT_MS : until };
}

/** Whether a scroll event at `now` is the app's: the window as it stands
 *  after that event, or null once it has closed and the scroll is the
 *  reader's. */
export function quietAt(w: AppScroll, now: number): AppScroll | null {
  if (now >= w.until) return null;
  return { until: Math.min(w.limit, Math.max(w.until, now + APP_SCROLL_TAIL_MS)), limit: w.limit };
}

/** Marks the scroll the app is about to make. Called just before it
 *  writes to the scroller, never after: the event can arrive first. */
export function markAppScroll(ref: RefObject<AppScroll> | undefined, smooth: boolean): void {
  if (ref) ref.current = appScrollAt(performance.now(), smooth);
}

/** Whether the header has gone up out of the way. */
export function useHeaderAway(
  scroller: RefObject<HTMLElement | null>,
  on: boolean,
  /** Changes whenever the app is about to move the map by its own hand
   *  in a way the quiet window cannot see coming — a recentre, rows
   *  closing up or coming back. Each change starts the watch again from
   *  wherever the map has landed. */
  settle: string = '',
  /** The window the app marks before scrolling the map itself. */
  appScroll?: RefObject<AppScroll>,
): boolean {
  const [away, setAway] = useState(false);
  useEffect(() => {
    const node = scroller.current;
    if (!on || !node) {
      setAway(false);
      return;
    }
    let from = node.scrollTop;
    const onScroll = () => {
      const to = node.scrollTop;
      if (appScroll) {
        const quiet = quietAt(appScroll.current, performance.now());
        if (quiet) {
          // The app is moving the map. Where it lands is where the
          // reader's own scrolling will be measured from.
          appScroll.current = quiet;
          from = to;
          return;
        }
      }
      const goes = headerGoes(from, to);
      if (goes === null) return;
      from = to;
      setAway(goes);
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, [scroller, on, settle, appScroll]);
  return on && away;
}

/** Whether the map under the header has been scrolled at all.
 *
 *  The header carries no rule at rest — on the opening screen there is
 *  nothing below it to divide, and on an unscrolled map the rating axis
 *  already draws a line a few pixels down. A hairline appears only once
 *  content has gone under the header, which is the moment it has
 *  something to separate.
 *
 *  `on` is false on the opening screen, where the answer is always no.
 */
export function useScrolledUnder(
  scroller: RefObject<HTMLElement | null>,
  on: boolean,
): boolean {
  const [under, setUnder] = useState(false);
  useEffect(() => {
    const node = scroller.current;
    if (!on || !node) {
      setUnder(false);
      return;
    }
    const read = () => setUnder(node.scrollTop > 0);
    read();
    node.addEventListener('scroll', read, { passive: true });
    return () => node.removeEventListener('scroll', read);
  }, [scroller, on]);
  return on && under;
}
