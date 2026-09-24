import { useEffect, useState, type RefObject } from 'react';

/** How far the reader has to move before the header takes the hint. Less
 *  than this and a thumb resting on the glass would flap it. */
export const HEADER_SLOP = 6;

/** Whether the header should be out of the way, given where the reader
 *  was and where they are now. `null` means leave it as it is.
 *
 *  Going down hides it, but not until they are past it: a header that
 *  vanished from the top of the page would take the first row with it. */
export function headerGoes(from: number, to: number, headerH: number): boolean | null {
  if (to <= 0) return false;
  const moved = to - from;
  if (moved > HEADER_SLOP && to > headerH) return true;
  if (moved < -HEADER_SLOP) return false;
  return null;
}

/** The header's own height, which the plot needs as a spacer because the
 *  header is lying over it rather than sitting above it. */
export function useHeaderHeight(
  ref: RefObject<HTMLElement | null>,
  on: boolean,
  /** What the header is holding. A ResizeObserver does not fire on a
   *  page that is not being painted — one opened in a background tab —
   *  and the map would then start under a header of the wrong height.
   *  Measuring again whenever the contents change covers that. */
  holding: string,
): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!on || !node) {
      setH(0);
      return;
    }
    const read = () => setH(node.getBoundingClientRect().height);
    read();
    // And once more off a timer, which runs whether or not anything is
    // being drawn, for the layout that had not happened yet.
    const retry = window.setTimeout(read, 0);
    const ro = new ResizeObserver(read);
    ro.observe(node);
    window.addEventListener('resize', read);
    return () => {
      window.clearTimeout(retry);
      ro.disconnect();
      window.removeEventListener('resize', read);
    };
  }, [ref, on, holding]);
  return on ? h : 0;
}

/** Whether the header has gone up out of the way. */
export function useHeaderAway(
  scroller: RefObject<HTMLElement | null>,
  on: boolean,
  headerH: number,
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
      const goes = headerGoes(from, to, headerH);
      if (goes === null) return;
      from = to;
      setAway(goes);
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, [scroller, on, headerH]);
  return on && away;
}
