import { useEffect, useState } from 'react';
import type { Viewport } from './layout';

/** Scroll offsets and viewport size, read once per frame. */
export function useViewport(): Viewport {
  const [v, setV] = useState<Viewport>(() => read());
  useEffect(() => {
    let queued = false;
    const onChange = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        setV(read());
      });
    };
    window.addEventListener('scroll', onChange, { passive: true });
    window.addEventListener('resize', onChange);
    onChange();
    return () => {
      window.removeEventListener('scroll', onChange);
      window.removeEventListener('resize', onChange);
    };
  }, []);
  return v;
}

function read(): Viewport {
  const el = document.scrollingElement ?? document.documentElement;
  return { sx: el.scrollLeft, sy: el.scrollTop, vw: window.innerWidth, vh: window.innerHeight };
}
