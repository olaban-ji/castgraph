import { useEffect, useRef, useState } from 'react';

/** The line's timeline, in percent of the header's width and in
 *  milliseconds. Every load takes the same one, whatever started it.
 *
 *  It cannot know how long the request will take, so it does what a
 *  progress line honestly can: jump to a token width, crawl most of the
 *  way while waiting (the crawl is the stylesheet's .9s transition), and
 *  only complete when the answer is in. */
export const PROGRESS = {
  /** Where it starts, the moment the load does. */
  start: 6,
  /** Where it crawls to while the request is out, and how soon after
   *  the start it sets off: long enough for the browser to paint the
   *  start, so the two are not merged into one transition. */
  crawl: 70,
  crawlAfterMs: 30,
  /** Left at full width this long after the answer lands, then faded. */
  fadeAfterMs: 380,
  /** Emptied once the fade is over, so the next load starts from
   *  nothing rather than shrinking back from the last one. */
  resetAfterMs: 900,
} as const;

/** A 2px line on the bottom edge of the header. */
export function useProgress(running: boolean) {
  const [width, setWidth] = useState(0);
  const [showing, setShowing] = useState(false);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const clear = () => {
      for (const t of timers.current) window.clearTimeout(t);
      timers.current = [];
    };
    clear();
    if (running) {
      setShowing(true);
      setWidth(PROGRESS.start);
      timers.current.push(window.setTimeout(() => setWidth(PROGRESS.crawl), PROGRESS.crawlAfterMs));
      return clear;
    }
    if (!showing) return clear;
    setWidth(100);
    // Let it land, then fade, then reset so the next request starts empty.
    timers.current.push(window.setTimeout(() => setShowing(false), PROGRESS.fadeAfterMs));
    timers.current.push(window.setTimeout(() => setWidth(0), PROGRESS.resetAfterMs));
    return clear;
    // `showing` must not restart this; only the request's state may.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  useEffect(
    () => () => {
      for (const t of timers.current) window.clearTimeout(t);
    },
    [],
  );

  return { width, showing };
}

export function Progress({ width, showing }: { width: number; showing: boolean }) {
  return (
    <div
      className={`cd-progress${showing ? ' cd-progress-on' : ''}`}
      style={{ width: `${width}%` }}
      aria-hidden="true"
    />
  );
}
