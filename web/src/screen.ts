import { useEffect, useState } from 'react';

/** Where the header goes, and how much of the wordmark shows.
 *
 *  `phone` is a narrow screen. `short` is a landscape phone: wide enough
 *  for the desktop layout but too short to give the header two rows. Both
 *  put the header over the map and hide it on scroll; only `phone` drops
 *  "inedikt" and moves the rating rungs into the View panel. */
export interface Screen {
  phone: boolean;
  short: boolean;
}

export const PHONE_MAX = 640;
export const SHORT_MAX = 500;

export function screenOf(width: number, height: number): Screen {
  const phone = width < PHONE_MAX;
  return { phone, short: !phone && height < SHORT_MAX };
}

/** Watches the window rather than an element: the header spans it, and a
 *  resize is the only thing that changes either answer. */
export function useScreen(): Screen {
  const [s, setS] = useState<Screen>(() =>
    typeof window === 'undefined'
      ? { phone: false, short: false }
      : screenOf(window.innerWidth, window.innerHeight),
  );
  useEffect(() => {
    const read = () => {
      const next = screenOf(window.innerWidth, window.innerHeight);
      setS((was) => (was.phone === next.phone && was.short === next.short ? was : next));
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
