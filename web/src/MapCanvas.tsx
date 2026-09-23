import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { edgeVisible, type MapFilters } from './filters';
import { traceLabelFor, type Trace } from './trace';
import { edgesWithin, filmsWithin, type Edge, type Layout, type PlacedFilm, type Viewport } from './layout';
import { Node, Skeleton } from './Node';

interface Props {
  layout: Layout;
  /** In canvas coordinates (already divided by zoom). */
  viewport: Viewport;
  zoom: number;
  /** Called with the scroll the canvas performs itself to keep the view
   *  steady when the layout shifts, so it is not mistaken for the reader's. */
  onCompensate?: (dx: number, dy: number) => void;
  /** Search-sized blow-out of a card already on the map. */
  onDeepen?: (filmId: string) => void;
  /** Re-anchor the whole map on a card that has already blown out. */
  onReanchor?: (filmId: string) => void;
  /** Open a film's detail sheet: the phone tap target and the keyboard path. */
  onOpen?: (filmId: string) => void;
  deepeningId?: string | null;
  deepened?: Set<string>;
  /** What the reader has narrowed the map to. */
  filters: MapFilters;
  /** Films that survive the filters; null when nothing is filtered. */
  visible: Set<string> | null;
  /** The route being traced through one person, if any. */
  trace: Trace | null;
}

/** Edge weight by billing: a lead's connection is a thicker line than a
 *  seventh-billed one. Directing has no billing and takes the top weight. */
export function edgeWidth(billing: number, director: boolean): number {
  if (director) return 3;
  return Math.max(1.5, 3 - Math.max(0, billing - 1) * 0.25);
}

/** The one film being asked about. Pointing, focusing, or (on touch)
 *  centring a card sets it; everything else on the map recedes. */
export type Active = { filmId: string; x: number; y: number } | null;

/** Virtualisation bands, in screens from the lit one: full cards up to
 *  LIVE_AT, shimmering skeletons up to SKELETON_AT, nothing beyond.
 *  Once a card is live it stays mounted until KEEP_LIVE_AT so scrolling
 *  back a little does not remount posters. */
export const LIVE_AT = 0.25;
export const KEEP_LIVE_AT = 1;
export const SKELETON_AT = 1.5;

/** Extra page pixels around the viewport for the painted SVG window, so
 *  fast scrolling does not clip lines before React catches up. Kept small
 *  enough that the backing store stays under mobile GPU texture limits. */
export const PAINT_OVERSCAN_PX = 360;

/** Stay on the current SVG window until the camera is this close to its
 *  edge, then recentre with a fresh overscan. Avoids reallocating the
 *  backing store on every React scroll tick. */
export const PAINT_SLACK_PX = 120;

export function MapCanvas({
  layout,
  viewport,
  zoom,
  onCompensate,
  onDeepen,
  onReanchor,
  onOpen,
  deepeningId,
  deepened,
  filters,
  visible,
  trace,
}: Props) {
  const { canvasW, canvasH, geometry: g } = layout;
  const liveEnter = filmsWithin(layout, viewport, LIVE_AT);
  const liveKeep = filmsWithin(layout, viewport, KEEP_LIVE_AT);
  const liveHeld = useRef(new Set<string>());
  // Rendered in year order, so tabbing through the map walks the
  // timeline rather than the order films happened to be virtualised in.
  const live = inYearOrder(holdFilms(liveHeld.current, liveEnter, liveKeep, layout.byId))
    .filter((f) => !visible || visible.has(f.id));
  liveHeld.current = new Set(live.map((f) => f.id));
  const liveIds = liveHeld.current;
  const skeletons = filmsWithin(layout, viewport, SKELETON_AT)
    .filter((f) => !liveIds.has(f.id) && (!visible || visible.has(f.id)));

  const [active, setActive] = useState<Active>(null);
  const [hoverEdge, setHoverEdge] = useState<Hover | null>(null);
  const activeFilmId = active?.filmId ?? null;
  // One film at a time answers "how is this connected?". Its edges light;
  // every other edge mutes. Hovering a line on its own lights that line.
  const lit = useMemo(() => {
    if (trace) return trace.edges;
    if (activeFilmId) return edgesOf(layout, activeFilmId);
    if (hoverEdge) return new Set([hoverEdge.edge.id]);
    return null;
  }, [trace, activeFilmId, hoverEdge, layout]);
  const tipEdge = hoverEdge?.edge ?? null;

  const stageW = Math.round(canvasW * zoom);
  const stageH = Math.round(canvasH * zoom);
  const paintRef = useRef<PaintBox | null>(null);
  const paintKeyRef = useRef('');
  const paintKey = `${layout.shift}:${layout.minYear}:${canvasW}:${canvasH}:${zoom}`;
  if (paintKeyRef.current !== paintKey) {
    paintKeyRef.current = paintKey;
    paintRef.current = null;
  }
  const windowBox = stickyPaintWindow(
    paintRef.current,
    {
      sx: viewport.sx * zoom,
      sy: viewport.sy * zoom,
      vw: viewport.vw * zoom,
      vh: viewport.vh * zoom,
      stageW,
      stageH,
    },
    PAINT_OVERSCAN_PX,
    PAINT_SLACK_PX,
  );
  paintRef.current = windowBox;
  const viewSx = windowBox.left / zoom;
  const viewSy = windowBox.top / zoom;
  const viewVw = windowBox.width / zoom;
  const viewVh = windowBox.height / zoom;
  const view = { sx: viewSx, sy: viewSy, vw: viewVw, vh: viewVh };
  const strip = useMemo(
    () => filmstrip(canvasW, layout, { sx: viewSx, sy: viewSy, vw: viewVw, vh: viewVh }),
    [canvasW, layout, viewSx, viewSy, viewVw, viewVh],
  );
  const edges = edgesWithin(layout, view, 0);
  useKeepViewportSteady(layout, zoom, onCompensate);

  const onFilmActivate = useCallback((filmId: string, x: number, y: number) => {
    setActive((a) => (a?.filmId === filmId && a.x === x && a.y === y ? a : { filmId, x, y }));
  }, []);
  const onFilmLeave = useCallback((filmId: string) => {
    setActive((a) => (a?.filmId === filmId ? null : a));
  }, []);

  // Touch has no hover: the film nearest the middle of the screen is the
  // one being asked about, so the same edge highlighting arrives by
  // scrolling to a card.
  const touch = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches,
    [],
  );
  const centred = touch ? nearestToCentre(live, viewport) : null;
  useEffect(() => {
    if (!touch) return;
    setActive((a) => (centred && a?.filmId !== centred ? { filmId: centred, x: 0, y: 0 } : a));
  }, [touch, centred]);

  const zoomed = zoom !== 1;
  const growth = useGrowthAnnouncement(layout.placed.length);

  return (
    <div
      className="mc-stage"
      id="mc-map"
      role="region"
      aria-label="Cast network map: films by year, connected by shared cast and directors"
      style={{ width: stageW, height: stageH }}
    >
      <p className="mc-sr-live" role="status" aria-live="polite">{growth}</p>
      <div className={`mc-canvas${zoomed ? ' mc-zoomed' : ''}`}>
        <div
          className="mc-film"
          style={{ left: windowBox.left, top: windowBox.top, width: windowBox.width, height: windowBox.height }}
        >
          <svg
            width={windowBox.width}
            height={windowBox.height}
            viewBox={`${view.sx} ${view.sy} ${view.vw} ${view.vh}`}
            style={{ display: 'block' }}
          >
            <defs>
              <pattern id="mc-sprocket" patternUnits="userSpaceOnUse" x="0" y="0" width={strip.railW} height={strip.pitch}>
                <rect x={strip.holeX} y={strip.holeY} width={strip.holeW} height={strip.holeH} rx={strip.holeR} fill="rgba(4,6,10,0.85)" stroke="rgba(226,232,244,0.17)" strokeWidth="1" />
              </pattern>
            </defs>
            {strip.leftRail && (
              <>
                <rect x={0} y={view.sy} width={strip.railW} height={view.vh} fill="rgba(255,255,255,0.022)" />
                <rect x={0} y={view.sy} width={strip.railW} height={view.vh} fill="url(#mc-sprocket)" />
              </>
            )}
            {strip.rightRail && (
              <>
                <rect x={strip.rightRailX} y={view.sy} width={strip.railW} height={view.vh} fill="rgba(255,255,255,0.022)" />
                <rect x={strip.rightRailX} y={view.sy} width={strip.railW} height={view.vh} fill="url(#mc-sprocket)" />
              </>
            )}
            <path d={strip.railEdgePath} fill="none" stroke="rgba(226,232,244,0.12)" strokeWidth="1" />
            <path d={strip.framePath} fill="none" stroke="rgba(226,232,244,0.045)" strokeWidth="1" />
            <path d={strip.frameIndexPath} fill="none" stroke="rgba(226,232,244,0.1)" strokeWidth="1" />
          </svg>
        </div>

        <svg
          className="mc-edges"
          data-active={lit ? '' : undefined}
          data-trace={trace ? '' : undefined}
          width={windowBox.width}
          height={windowBox.height}
          viewBox={`${view.sx} ${view.sy} ${view.vw} ${view.vh}`}
          style={{ left: windowBox.left, top: windowBox.top, width: windowBox.width, height: windowBox.height }}
        >
          {edges.map((e) => {
            const on = !!lit && lit.has(e.id);
            // A long run is clutter at rest and an answer when asked for.
            if (e.long && !on) return null;
            if (!edgeVisible(e, filters, visible)) return null;
            const anchorEdge = e.from.anchor || e.to.anchor;
            // On a trace, the person's own hops are the answer and the
            // rest of the route is the context that makes them reachable.
            const through = !!trace && trace.through.has(e.id);
            const cls = [
              'mc-edge',
              on ? 'mc-edge-active' : '',
              trace && on ? (through ? 'mc-edge-through' : 'mc-edge-route') : '',
              e.director ? 'mc-edge-direct' : 'mc-edge-cast',
              anchorEdge ? 'mc-edge-anchor' : '',
            ].filter(Boolean).join(' ');
            return (
              <g
                key={e.id}
                className={cls}
                style={{ ['--edge-w' as string]: edgeWidth(e.billing, e.director) }}
                onMouseEnter={(ev) => setHoverEdge({ edge: e, x: ev.clientX, y: ev.clientY })}
                onMouseMove={(ev: MouseEvent) =>
                  setHoverEdge((h) => (h ? { ...h, x: ev.clientX, y: ev.clientY } : h))
                }
                onMouseLeave={() => setHoverEdge((h) => (h?.edge.id === e.id ? null : h))}
              >
                <path d={e.d} fill="none" stroke="transparent" strokeWidth="24" strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: 'stroke' }} />
                {on && (
                  <path
                    className="mc-edge-casing"
                    d={e.d}
                    fill="none"
                    strokeWidth={edgeWidth(e.billing, e.director) + 5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ pointerEvents: 'none' }}
                  />
                )}
                <path
                  className="mc-edge-line"
                  d={e.d}
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ pointerEvents: 'none' }}
                />
              </g>
            );
          })}
        </svg>

        {live.map((f) => (
          <Node
            key={f.id}
            film={f}
            g={g}
            zoom={zoom}
            active={activeFilmId === f.id}
            onRoute={!!trace && trace.films.has(f.id)}
            traceLabel={trace ? traceLabelFor(layout, trace, f.id) : undefined}
            tabIndex={0}
            longEdges={layout.longByFilm.get(f.id) ?? 0}
            onActivate={onFilmActivate}
            onDeactivate={onFilmLeave}
            onDeepen={!f.anchor && onDeepen && !deepened?.has(f.id) ? onDeepen : undefined}
            onReanchor={!f.anchor && deepened?.has(f.id) ? onReanchor : undefined}
            onOpen={onOpen}
            deepening={deepeningId === f.id}
          />
        ))}
        {skeletons.map((f) => (
          <Skeleton key={f.id} film={f} g={g} zoom={zoom} />
        ))}
      </div>

      {hoverEdge && tipEdge && (
        <div className="mc-tip" style={{ left: Math.min(hoverEdge.x + 16, window.innerWidth - 230), top: Math.max(72, hoverEdge.y - 20) }}>
          {tipEdge.people.map((q) => (
            <div className="mc-tip-person" key={q.name}>
              <div className="mc-tip-actor">{q.name}</div>
              {q.role && (
                <div className="mc-tip-role">
                  {q.director ? 'directed' : `as ${q.role}`}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export type Hover = { edge: Edge; x: number; y: number };

export type PaintBox = { left: number; top: number; width: number; height: number };

/** Viewport in page pixels plus the stage it is clamped to. */
export type PaintView = {
  sx: number;
  sy: number;
  vw: number;
  vh: number;
  stageW: number;
  stageH: number;
};

/** Page-pixel rectangle covering the viewport plus overscan, clamped to the
 *  stage so the SVG backing store stays roughly one screen. */
export function paintWindow(
  sx: number,
  sy: number,
  vw: number,
  vh: number,
  stageW: number,
  stageH: number,
  overscan: number,
): PaintBox {
  const left = Math.max(0, sx - overscan);
  const top = Math.max(0, sy - overscan);
  const right = Math.min(stageW, sx + vw + overscan);
  const bottom = Math.min(stageH, sy + vh + overscan);
  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/** True if `box` still covers the viewport with `slack` pixels of margin,
 *  after clamping the needed rectangle to the stage. */
export function paintWindowCovers(box: PaintBox, view: PaintView, slack: number): boolean {
  const needL = Math.max(0, view.sx - slack);
  const needT = Math.max(0, view.sy - slack);
  const needR = Math.min(view.stageW, view.sx + view.vw + slack);
  const needB = Math.min(view.stageH, view.sy + view.vh + slack);
  return (
    needL >= box.left &&
    needT >= box.top &&
    needR <= box.left + box.width &&
    needB <= box.top + box.height
  );
}

/** Keep the last paint window until the camera nears its edge, then
 *  recentre with a fresh overscan. */
export function stickyPaintWindow(
  prev: PaintBox | null,
  view: PaintView,
  overscan: number,
  slack: number,
): PaintBox {
  if (prev && paintWindowCovers(prev, view, slack)) return prev;
  return paintWindow(view.sx, view.sy, view.vw, view.vh, view.stageW, view.stageH, overscan);
}

/** Mounted films sorted the way a reader travels them: by year, then
 *  left to right. DOM order is tab order. */
export function inYearOrder(films: PlacedFilm[]): PlacedFilm[] {
  return [...films].sort((a, b) => a.year - b.year || a.x - b.x || a.id.localeCompare(b.id));
}

/** Films in the enter band, plus any previously live film still inside
 *  the keep band, resolved against the current layout. */
export function holdFilms(
  prevIds: Set<string>,
  enter: PlacedFilm[],
  keep: PlacedFilm[],
  byId: Map<string, PlacedFilm>,
): PlacedFilm[] {
  const keepIds = new Set(keep.map((f) => f.id));
  const ids = new Set(enter.map((f) => f.id));
  for (const id of prevIds) {
    if (keepIds.has(id)) ids.add(id);
  }
  const out: PlacedFilm[] = [];
  for (const id of ids) {
    const f = byId.get(id);
    if (f) out.push(f);
  }
  return out;
}

/** What the traced person did in this film, for a card standing on the
 *  route. Films that are only passed through say nothing extra. */

/** Every edge into or out of a film: the lines that answer "how is this
 *  connected to what I searched?". */
export function edgesOf(layout: Layout, filmId: string): Set<string> {
  const ids = new Set<string>();
  for (const e of layout.edges) {
    if (e.from.id === filmId || e.to.id === filmId) ids.add(e.id);
  }
  return ids;
}

/** The mounted film whose card centre is nearest the middle of the
 *  window. Used where there is no pointer to hover with. */
export function nearestToCentre(films: PlacedFilm[], v: Viewport): string | null {
  const cx = v.sx + v.vw / 2;
  const cy = v.sy + v.vh / 2;
  let best: string | null = null;
  let bestD = Infinity;
  for (const f of films) {
    const d = Math.hypot(f.x - cx, f.y - cy);
    if (d < bestD) {
      bestD = d;
      best = f.id;
    }
  }
  return best;
}

/** Celluloid substrate: perforated sprocket rails on the outer margins,
 *  frame lines at every year in the painted window, heavier ones at decades. */
function filmstrip(canvasW: number, layout: Layout, view: { sx: number; sy: number; vw: number; vh: number }) {
  const railW = 54;
  const pitch = Math.max(46, Math.min(84, Math.round(layout.geometry.ppy)));
  const holeW = 26;
  const holeH = Math.round(pitch * 0.38);
  const rightRailX = canvasW - railW;
  const x0 = view.sx;
  const x1 = view.sx + view.vw;
  const y0 = view.sy;
  const y1 = view.sy + view.vh;
  const origin = layout.yOf(layout.minYear);
  const ppy = layout.geometry.ppy;
  const yLo = Math.max(layout.minYear, Math.floor((y0 - origin) / ppy) - 1);
  const yHi = Math.min(layout.maxYear, Math.ceil((y1 - origin) / ppy) + 1);
  const frames: string[] = [];
  const index: string[] = [];
  if (yLo <= yHi) {
    for (let y = yLo; y <= yHi; y++) {
      const py = Math.round(layout.yOf(y)) + 0.5;
      (y % 10 === 0 ? index : frames).push(`M ${railW} ${py} H ${rightRailX}`);
    }
  }
  const rails = [railW, rightRailX].filter((x) => x + 0.5 >= x0 && x + 0.5 <= x1);
  return {
    railW, rightRailX, pitch, holeW, holeH,
    holeX: Math.round((railW - holeW) / 2),
    holeY: Math.round((pitch - holeH) / 2),
    holeR: Math.round(holeH * 0.34),
    leftRail: x1 > 0 && x0 < railW,
    rightRail: x1 > rightRailX && x0 < canvasW,
    railEdgePath: rails.map((x) => `M ${x + 0.5} ${y0} V ${y1}`).join(' '),
    framePath: frames.join(' '),
    frameIndexPath: index.join(' '),
  };
}

/** Announces map growth to a screen reader, batched: a film arriving
 *  every few hundred milliseconds would otherwise produce a stream of
 *  interruptions rather than one useful sentence. */
export function useGrowthAnnouncement(count: number, quietMs = 1200): string {
  const [message, setMessage] = useState('');
  const seen = useRef(count);
  useEffect(() => {
    if (count === seen.current) return;
    const t = setTimeout(() => {
      const added = count - seen.current;
      seen.current = count;
      if (added > 0) setMessage(`${added} more ${added === 1 ? 'film' : 'films'} added. ${count} on the map.`);
    }, quietMs);
    return () => clearTimeout(t);
  }, [count, quietMs]);
  return message;
}

/** New data can add a film further left or earlier than anything placed,
 *  which shifts every node right or down. Scroll by the same amount (in
 *  page px, so scaled by zoom) so what the reader is looking at stays put. */
function useKeepViewportSteady(layout: Layout, zoom: number, onCompensate?: (dx: number, dy: number) => void) {
  const prev = useRef<{ shift: number; minYear: number; ppy: number } | null>(null);
  useLayoutEffect(() => {
    const cur = { shift: layout.shift, minYear: layout.minYear, ppy: layout.geometry.ppy };
    const p = prev.current;
    prev.current = cur;
    if (!p || p.ppy !== cur.ppy) return;
    const dx = (cur.shift - p.shift) * zoom;
    const dy = (p.minYear - cur.minYear) * cur.ppy * zoom;
    if (dx !== 0 || dy !== 0) {
      onCompensate?.(dx, dy);
      window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    }
  }, [layout, zoom, onCompensate]);
}
