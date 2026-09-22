import { useCallback, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { decadeColour, edgesWithin, filmsWithin, type Edge, type Layout, type PlacedFilm, type Viewport } from './layout';
import { Node, Skeleton } from './Node';

interface Props {
  layout: Layout;
  /** In canvas coordinates (already divided by zoom). */
  viewport: Viewport;
  zoom: number;
  background: 'funky' | 'noir';
  /** Called with the scroll the canvas performs itself to keep the view
   *  steady when the layout shifts, so it is not mistaken for the reader's. */
  onCompensate?: (dx: number, dy: number) => void;
  /** Search-sized blow-out of a card already on the map. */
  onDeepen?: (filmId: string) => void;
  deepeningId?: string | null;
  deepened?: Set<string>;
}

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
  background,
  onCompensate,
  onDeepen,
  deepeningId,
  deepened,
}: Props) {
  const { canvasW, canvasH, geometry: g } = layout;
  const liveEnter = filmsWithin(layout, viewport, LIVE_AT);
  const liveKeep = filmsWithin(layout, viewport, KEEP_LIVE_AT);
  const liveHeld = useRef(new Set<string>());
  const live = holdFilms(liveHeld.current, liveEnter, liveKeep, layout.byId);
  liveHeld.current = new Set(live.map((f) => f.id));
  const liveIds = liveHeld.current;
  const skeletons = filmsWithin(layout, viewport, SKELETON_AT).filter((f) => !liveIds.has(f.id));

  const [hover, setHover] = useState<Hover | null>(null);
  // Only the hovered line, or the line the hovered film sits on, lights up.
  const lit = useMemo(() => (hover ? edgesAlong(layout, hover) : null), [hover, layout]);
  const litNodes = useMemo(() => {
    if (!lit) return null;
    const ids = new Set<string>();
    for (const e of layout.edges) if (lit.has(e.id)) ids.add(e.from.id).add(e.to.id);
    if (hover?.kind === 'film') ids.add(hover.filmId);
    return ids;
  }, [lit, layout, hover]);
  const tipEdge = hover?.kind === 'edge' ? hover.edge : null;

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

  const onFilmHover = useCallback(
    (filmId: string, x: number, y: number) => {
      const film = layout.byId.get(filmId);
      if (!film) return;
      setHover({ kind: 'film', filmId, edge: edgeForFilm(layout, film), x, y });
    },
    [layout],
  );
  const onFilmLeave = useCallback((filmId: string) => {
    setHover((h) => (h?.kind === 'film' && h.filmId === filmId ? null : h));
  }, []);

  const zoomed = zoom !== 1;

  return (
    <div className="mc-stage" style={{ width: stageW, height: stageH }}>
      <div className={background === 'noir' ? 'mc-bg-noir' : 'mc-bg-funky'}>
        <div className="mc-blob mc-blob-a" />
        <div className="mc-blob mc-blob-b" />
        <div className="mc-blob mc-blob-c" />
        <div className="mc-zone" />
      </div>

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
          width={windowBox.width}
          height={windowBox.height}
          viewBox={`${view.sx} ${view.sy} ${view.vw} ${view.vh}`}
          style={{ left: windowBox.left, top: windowBox.top, width: windowBox.width, height: windowBox.height }}
        >
          <defs>
            {edges.map((e) =>
              e.kind === 'branch' ? (
                <linearGradient key={e.id} id={`grad-${e.id}`} gradientUnits="userSpaceOnUse" x1={e.from.x} y1={e.from.y} x2={e.to.x} y2={e.to.y}>
                  <stop offset="0%" stopColor={decadeColour(e.from.year)} />
                  <stop offset="100%" stopColor={decadeColour(e.to.year)} />
                </linearGradient>
              ) : null,
            )}
          </defs>
          {edges.map((e) => {
            const on = !lit || lit.has(e.id);
            const highlight = !!lit && on;
            const width = 3.2;
            let opacity = 0.88;
            if (!on) opacity = 0.14;
            else if (highlight) opacity = 1;
            const stroke = `url(#grad-${e.id})`;
            return (
              <g
                key={e.id}
                className="mc-edge"
                onMouseEnter={(ev) => setHover({ kind: 'edge', edge: e, x: ev.clientX, y: ev.clientY })}
                onMouseMove={(ev: MouseEvent) =>
                  setHover((h) => (h?.kind === 'edge' ? { ...h, x: ev.clientX, y: ev.clientY } : h))
                }
                onMouseLeave={() => setHover((h) => (h?.kind === 'edge' && h.edge.id === e.id ? null : h))}
              >
                <path d={e.d} fill="none" stroke="transparent" strokeWidth="24" strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: 'stroke' }} />
                <path
                  d={e.d}
                  fill="none"
                  stroke="#0b0f19"
                  strokeOpacity={on ? 0.92 : 0.4}
                  strokeWidth={width + 5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ pointerEvents: 'none' }}
                />
                {highlight && (
                  <path
                    d={e.d}
                    fill="none"
                    stroke="#8B93A1"
                    strokeOpacity={0.22}
                    strokeWidth={10}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ pointerEvents: 'none' }}
                  />
                )}
                <path
                  className="mc-edge-line"
                  d={e.d}
                  fill="none"
                  stroke={stroke}
                  strokeOpacity={opacity}
                  strokeWidth={highlight ? width + 1.2 : width}
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
            dim={!!litNodes && !litNodes.has(f.id)}
            onHover={onFilmHover}
            onLeave={onFilmLeave}
            onDeepen={!f.anchor && onDeepen && !deepened?.has(f.id) ? onDeepen : undefined}
            deepening={deepeningId === f.id}
          />
        ))}
        {skeletons.map((f) => (
          <Skeleton key={f.id} film={f} g={g} zoom={zoom} />
        ))}
      </div>

      {hover && tipEdge && (
        <div className="mc-tip" style={{ left: Math.min(hover.x + 16, window.innerWidth - 230), top: Math.max(72, hover.y - 20) }}>
          <div className="mc-tip-actor">{tipEdge.actor}</div>
          {tipEdge.role && (
            <div className="mc-tip-role">
              {tipEdge.role === 'Director' ? 'directed' : `as ${tipEdge.role}`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export type Hover =
  | { kind: 'edge'; edge: Edge; x: number; y: number }
  | { kind: 'film'; filmId: string; edge: Edge | null; x: number; y: number };

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

/** The lines a film sits on: every edge into or out of it. Hovering a
 *  line lights only that line. */
export function edgesAlong(layout: Layout, hover: Hover): Set<string> {
  if (hover.kind === 'edge') return new Set([hover.edge.id]);
  const ids = new Set<string>();
  for (const e of layout.edges) {
    if (e.from.id === hover.filmId || e.to.id === hover.filmId) ids.add(e.id);
  }
  return ids;
}

function edgeForFilm(layout: Layout, film: PlacedFilm): Edge | null {
  return layout.edges.find((e) => e.to.id === film.id || e.from.id === film.id) ?? null;
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
