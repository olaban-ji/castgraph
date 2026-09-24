import { useEffect, useRef, useState } from 'react';

/** A 2px line on the bottom edge of the header.
 *
 *  It cannot know how long the request will take, so it does what a
 *  progress line honestly can: jump to a token 8%, crawl most of the way
 *  while waiting, and only complete when the answer is in. */
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
      setWidth(8);
      timers.current.push(window.setTimeout(() => setWidth(62), 40));
      return clear;
    }
    if (!showing) return clear;
    setWidth(100);
    // Let it land, then fade, then reset so the next request starts empty.
    timers.current.push(window.setTimeout(() => setShowing(false), 400));
    timers.current.push(window.setTimeout(() => setWidth(0), 800));
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
