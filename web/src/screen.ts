import { useEffect, useState } from 'react';

/** Where the header goes, and how much of the wordmark shows.
 *
 *  `phone` is a narrow screen. `short` is a landscape phone: wide enough
 *  for the desktop layout but too short to give the header two rows. Both
 *  put the header over the map and hide it on scroll; only `phone` drops
 *  "inedikt".
 *
 *  `narrow` is wider than a phone and still too narrow for the rating
 *  rungs to sit beside the wordmark and the search field. Between 641
 *  and 860 px they wrapped to a second row, and the header changed
 *  height the moment a map arrived — so they go into the View panel
 *  instead, the same place a phone keeps them. */
export interface Screen {
  phone: boolean;
  short: boolean;
  narrow: boolean;
}

export const PHONE_MAX = 640;
export const SHORT_MAX = 500;
/** The width the header first has room for everything at once. */
export const RUNGS_MIN = 1024;

export function screenOf(width: number, height: number): Screen {
  const phone = width < PHONE_MAX;
  return { phone, short: !phone && height < SHORT_MAX, narrow: width < RUNGS_MIN };
}

/** Watches the window rather than an element: the header spans it, and a
 *  resize is the only thing that changes either answer. */
export function useScreen(): Screen {
  const [s, setS] = useState<Screen>(() =>
    typeof window === 'undefined'
      ? { phone: false, short: false, narrow: false }
      : screenOf(window.innerWidth, window.innerHeight),
  );
  useEffect(() => {
    const read = () => {
      const next = screenOf(window.innerWidth, window.innerHeight);
      setS((was) =>
        was.phone === next.phone && was.short === next.short && was.narrow === next.narrow
          ? was
          : next,
      );
    };
    read();
    window.addEventListener('resize', read);
    window.addEventListener('orientationchange', read);
    return () => {
      window.removeEventListener('resize', read);
      window.removeEventListener('orientationchange', read);
    };
  }, []);
  return s;
}
