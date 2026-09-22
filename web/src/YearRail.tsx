import { useLayoutEffect, useRef } from 'react';
import type { Layout } from './layout';

interface Props {
  layout: Layout;
  zoom: number;
  headerHeight: number;
}

/** A fixed column of year ticks that tracks the canvas as it scrolls:
 *  decades in bold, plus every year that has a film. The gold line marks
 *  the year at the centre of the screen. The inner column is transformed
 *  from the scroll listener so the rail stays off the React hot path. */
export function YearRail({ layout, zoom, headerHeight }: Props) {
  const innerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    let queued = false;
    const apply = () => {
      queued = false;
      const el = document.scrollingElement ?? document.documentElement;
      inner.style.transform = `translateY(${-el.scrollTop - headerHeight}px)`;
    };
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(apply);
    };
    apply();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [headerHeight]);

  const years = new Set(layout.placed.map((p) => p.year));
  const ticks: { year: number; decade: boolean; y: number }[] = [];
  for (let y = layout.minYear; y <= layout.maxYear; y++) {
    const decade = y % 10 === 0;
    if (!decade && !years.has(y)) continue;
    ticks.push({ year: y, decade, y: Math.round(layout.yOf(y) * zoom) });
  }
  return (
    <div className="mc-rail" aria-hidden="true">
      <div className="mc-rail-inner" ref={innerRef}>
        {ticks.map((t) => (
          <div key={t.year}>
            <div
              className={`mc-rail-tick${t.decade ? ' mc-rail-tick-decade' : ''}`}
              style={{ left: t.decade ? 8 : 14, top: t.y, width: t.decade ? 18 : 10, height: t.decade ? 2 : 1 }}
            />
            <div className={`mc-rail-label${t.decade ? ' mc-rail-label-decade' : ''}`} style={{ left: t.decade ? 30 : 28, top: t.y - 7 }}>
              {t.year}
            </div>
          </div>
        ))}
      </div>
      <div className="mc-rail-now" />
    </div>
  );
}
