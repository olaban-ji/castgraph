import { useEffect, useState } from 'react';
import type { Viewport } from './layout';

/** React only hears about scroll after the camera has moved this far.
 *  The canvas overscan covers the gap, so lines do not clip. */
export const VIEWPORT_STEP_PX = 96;

/** After the camera stops, wait this long before treating it as idle
 *  (expansion, exact viewport flush, entrance motion). */
export const SCROLL_IDLE_MS = 140;

/** True when a resize happened or the camera moved at least `stepPx`. */
export function viewportStepped(prev: Viewport, next: Viewport, stepPx: number): boolean {
  return (
    next.vw !== prev.vw ||
    next.vh !== prev.vh ||
    Math.abs(next.sx - prev.sx) >= stepPx ||
    Math.abs(next.sy - prev.sy) >= stepPx
  );
}

/** Scroll offsets and viewport size. Resize is immediate; scroll is
 *  published in steps so React is not on every frame. */
export function useViewport(): Viewport {
  const [v, setV] = useState<Viewport>(() => read());
  useEffect(() => {
    let queued = false;
    let idleTimer = 0;
    let last = read();

    const publish = (next: Viewport) => {
      last = next;
      setV((prev) =>
        prev.sx === next.sx && prev.sy === next.sy && prev.vw === next.vw && prev.vh === next.vh
          ? prev
          : next,
      );
    };

    const onFrame = () => {
      queued = false;
      const next = read();
      if (viewportStepped(last, next, VIEWPORT_STEP_PX)) publish(next);
    };

    const onScroll = () => {
      document.documentElement.classList.add('mc-scrolling');
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        document.documentElement.classList.remove('mc-scrolling');
        publish(read());
      }, SCROLL_IDLE_MS);
      if (queued) return;
      queued = true;
      requestAnimationFrame(onFrame);
    };

    const onResize = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(onFrame);
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    onResize();
    return () => {
      window.clearTimeout(idleTimer);
      document.documentElement.classList.remove('mc-scrolling');
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  }, []);
  return v;
}

/** False while the camera is moving, true after `delayMs` of stillness. */
export function useScrollIdle(delayMs = SCROLL_IDLE_MS): boolean {
  const [idle, setIdle] = useState(true);
  useEffect(() => {
    let timer = 0;
    let moving = false;
    const onScroll = () => {
      if (!moving) {
        moving = true;
        setIdle(false);
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        moving = false;
        setIdle(true);
      }, delayMs);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('scroll', onScroll);
    };
  }, [delayMs]);
  return idle;
}

function read(): Viewport {
  const el = document.scrollingElement ?? document.documentElement;
  return { sx: el.scrollLeft, sy: el.scrollTop, vw: window.innerWidth, vh: window.innerHeight };
}
