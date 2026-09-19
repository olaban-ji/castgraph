import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { decadeColour, filmsWithin, type Edge, type Layout, type PlacedFilm, type Viewport } from './layout';
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
  /** Reports how many cards are live and how many are loading placeholders. */
  onBands?: (live: number, loading: number) => void;
}

/** Virtualisation bands, in screens from the lit one: full cards up to
 *  LIVE_AT, shimmering skeletons up to SKELETON_AT, nothing beyond. */
export const LIVE_AT = 0.25;
export const SKELETON_AT = 1.5;

export function MapCanvas({ layout, viewport, zoom, background, onCompensate, onBands }: Props) {
  const { canvasW, canvasH, geometry: g } = layout;
  const live = filmsWithin(layout, viewport, LIVE_AT);
  const liveIds = new Set(live.map((f) => f.id));
  const skeletons = filmsWithin(layout, viewport, SKELETON_AT).filter((f) => !liveIds.has(f.id));
  onBands?.(live.length, skeletons.length);

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
  const tipEdge = hover?.kind === 'edge' ? hover.edge : hover?.edge;

  const film = useMemo(() => filmstrip(canvasW, canvasH, layout), [canvasW, canvasH, layout]);
  useKeepViewportSteady(layout, zoom, onCompensate);

  const stageW = Math.round(canvasW * zoom);
  const stageH = Math.round(canvasH * zoom);

  return (
    <div className="mc-stage" style={{ width: stageW, height: stageH }}>
      <div className={background === 'noir' ? 'mc-bg-noir' : 'mc-bg-funky'}>
        <div className="mc-blob mc-blob-a" />
        <div className="mc-blob mc-blob-b" />
        <div className="mc-blob mc-blob-c" />
        <div className="mc-zone" />
      </div>

      <div className={`mc-canvas${zoom !== 1 ? ' mc-zoomed' : ''}`} style={{ width: canvasW, height: canvasH, transform: `scale(${zoom})` }}>
        <div className="mc-film" style={{ width: canvasW, height: canvasH }}>
          <svg width={canvasW} height={canvasH} viewBox={`0 0 ${canvasW} ${canvasH}`} style={{ display: 'block' }}>
            <defs>
              <pattern id="mc-sprocket" patternUnits="userSpaceOnUse" x="0" y="0" width={film.railW} height={film.pitch}>
                <rect x={film.holeX} y={film.holeY} width={film.holeW} height={film.holeH} rx={film.holeR} fill="rgba(4,6,10,0.85)" stroke="rgba(226,232,244,0.17)" strokeWidth="1" />
              </pattern>
            </defs>
            <rect x="0" y="0" width={film.railW} height={canvasH} fill="rgba(255,255,255,0.022)" />
            <rect x={film.rightRailX} y="0" width={film.railW} height={canvasH} fill="rgba(255,255,255,0.022)" />
            <rect x="0" y="0" width={film.railW} height={canvasH} fill="url(#mc-sprocket)" />
            <rect x={film.rightRailX} y="0" width={film.railW} height={canvasH} fill="url(#mc-sprocket)" />
            <path d={film.railEdgePath} fill="none" stroke="rgba(226,232,244,0.12)" strokeWidth="1" />
            <path d={film.framePath} fill="none" stroke="rgba(226,232,244,0.045)" strokeWidth="1" />
            <path d={film.frameIndexPath} fill="none" stroke="rgba(226,232,244,0.1)" strokeWidth="1" />
          </svg>
        </div>

        <svg className="mc-edges" width={canvasW} height={canvasH} viewBox={`0 0 ${canvasW} ${canvasH}`}>
          <defs>
            {layout.edges.map((e) =>
              e.kind === 'branch' ? (
                <linearGradient key={e.id} id={`grad-${e.id}`} gradientUnits="userSpaceOnUse" x1={e.from.x} y1={e.from.y} x2={e.to.x} y2={e.to.y}>
                  <stop offset="0%" stopColor={decadeColour(e.from.year)} />
                  <stop offset="100%" stopColor={decadeColour(e.to.year)} />
                </linearGradient>
              ) : null,
            )}
          </defs>
          {layout.edges.map((e) => {
            const on = !lit || lit.has(e.id);
            const highlight = !!lit && on;
            const width = e.kind === 'trunk' ? 4.5 : 3.2;
            let opacity = e.kind === 'trunk' ? 0.95 : 0.88;
            if (!on) opacity = 0.14;
            else if (highlight) opacity = 1;
            const stroke = e.kind === 'trunk' ? 'var(--accent)' : `url(#grad-${e.id})`;
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
                    stroke={e.kind === 'trunk' ? 'var(--accent)' : '#8B93A1'}
                    strokeOpacity={e.kind === 'trunk' ? 0.28 : 0.22}
                    strokeWidth={e.kind === 'trunk' ? 14 : 10}
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
            dim={!!litNodes && !litNodes.has(f.id)}
            onHover={(x, y) => setHover({ kind: 'film', filmId: f.id, edge: edgeForFilm(layout, f), x, y })}
            onLeave={() => setHover((h) => (h?.kind === 'film' && h.filmId === f.id ? null : h))}
          />
        ))}
        {skeletons.map((f) => (
          <Skeleton key={f.id} film={f} g={g} />
        ))}
      </div>

      {hover && tipEdge && (
        <div className="mc-tip" style={{ left: Math.min(hover.x + 16, window.innerWidth - 230), top: Math.max(72, hover.y - 20) }}>
          <div className="mc-tip-actor">{tipEdge.actor}</div>
          {tipEdge.role && <div className="mc-tip-role">as {tipEdge.role}</div>}
        </div>
      )}
    </div>
  );
}

export type Hover =
  | { kind: 'edge'; edge: Edge; x: number; y: number }
  | { kind: 'film'; filmId: string; edge: Edge | null; x: number; y: number };

/** The line a film sits on: its incoming branch, or the adjacent trunk
 *  segments for a trunk stop. Hovering a line lights only that line. */
export function edgesAlong(layout: Layout, hover: Hover): Set<string> {
  if (hover.kind === 'edge') return new Set([hover.edge.id]);
  const film = layout.byId.get(hover.filmId);
  const ids = new Set<string>();
  for (const e of layout.edges) {
    const onTrunk = film?.trunk && e.kind === 'trunk' && (e.from.id === hover.filmId || e.to.id === hover.filmId);
    if (onTrunk || e.to.id === hover.filmId) ids.add(e.id);
  }
  return ids;
}

function edgeForFilm(layout: Layout, film: PlacedFilm): Edge | null {
  return (
    layout.edges.find((e) => e.to.id === film.id) ??
    (film.trunk ? layout.edges.find((e) => e.kind === 'trunk' && (e.from.id === film.id || e.to.id === film.id)) : undefined) ??
    null
  );
}

/** Celluloid substrate: perforated sprocket rails on the outer margins,
 *  frame lines at every year, heavier ones at decades. */
function filmstrip(canvasW: number, canvasH: number, layout: Layout) {
  const railW = 54;
  const pitch = Math.max(46, Math.min(84, Math.round(layout.geometry.ppy)));
  const holeW = 26;
  const holeH = Math.round(pitch * 0.38);
  const rightRailX = canvasW - railW;
  const frames: string[] = [];
  const index: string[] = [];
  for (let y = layout.minYear; y <= layout.maxYear; y++) {
    const py = Math.round(layout.yOf(y)) + 0.5;
    (y % 10 === 0 ? index : frames).push(`M ${railW} ${py} H ${rightRailX}`);
  }
  return {
    railW, rightRailX, pitch, holeW, holeH,
    holeX: Math.round((railW - holeW) / 2),
    holeY: Math.round((pitch - holeH) / 2),
    holeR: Math.round(holeH * 0.34),
    railEdgePath: [railW, rightRailX].map((x) => `M ${x + 0.5} 0 V ${canvasH}`).join(' '),
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
