import { useEffect, useRef } from 'react';
import { histBars } from './grid';

interface Props {
  /** The oldest and newest year this map holds. The ends of the control
   *  are the map's own ends, so a reader is never offered a decade the
   *  cast never worked in. */
  lo: number;
  hi: number;
  /** Null on either side is open. */
  from: number | null;
  to: number | null;
  /** Called on every change, including mid-drag. */
  onChange: (from: number | null, to: number | null) => void;
  /** Called once the change is settled: pointer up or key up. The map
   *  is put back on the searched film then, not on every year the thumb
   *  passes over. */
  onSettled: () => void;
  /** How many films each year holds (see yearCounts), drawn as a
   *  histogram over the track. None given, none drawn. */
  counts?: ReadonlyMap<number, number>;
}

/** Which thumb is being moved. */
type Side = 'from' | 'to';

/** How far a PageUp moves. */
const PAGE = 10;

/** How far the drawn track is held in from each end, so a thumb on the
 *  first or last year still sits on it rather than half off. The
 *  histogram's bars and the year labels under the ends share it. */
const TRACK_INSET = 12;

/** The year range: a two-thumb slider, with how many films each year
 *  holds drawn over it and the map's first and last years under it.
 *
 *  Two divs with `role="slider"` rather than two stacked `<input
 *  type="range">`: stacked native ranges fight over the pointer, and in
 *  Safari the one on top takes every press whichever thumb was aimed at.
 *
 *  A range from end to end is no range at all, so a thumb that reaches
 *  a bound opens that side. Otherwise the reader would have to know
 *  that 1931–2024 and "all years" are the same thing. */
export function YearRange({ lo, hi, from, to, onChange, onSettled, counts }: Props) {
  const track = useRef<HTMLDivElement>(null);
  const thumbs = useRef<Record<Side, HTMLDivElement | null>>({ from: null, to: null });
  // Where the thumbs sit while either side is open.
  const a = from ?? lo;
  const b = to ?? hi;
  const span = Math.max(hi - lo, 1);

  // One layout per frame while dragging. A pointermove can arrive far
  // more often than the screen is painted, and each one relays four
  // hundred cards.
  const frame = useRef(0);
  const queued = useRef<[number | null, number | null] | null>(null);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const send = (nextFrom: number | null, nextTo: number | null) => {
    queued.current = [nextFrom, nextTo];
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const q = queued.current;
      if (q) onChange(q[0], q[1]);
    });
  };

  /** A year, with the ends read as "open on that side". */
  const set = (side: Side, year: number) => {
    const bounded = Math.min(Math.max(year, lo), hi);
    if (side === 'from') {
      send(bounded <= lo ? null : bounded, to);
    } else {
      send(from, bounded >= hi ? null : bounded);
    }
  };

  const drag = (side: Side, clientX: number) => {
    const frac = fractionAt(clientX);
    if (frac == null) return;
    const year = Math.round(lo + frac * span);
    // The thumbs cannot cross: a dragged thumb stops at the other one.
    set(side, side === 'from' ? Math.min(year, b) : Math.max(year, a));
  };

  const startDrag = (side: Side, e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    thumbs.current[side]?.focus();
    drag(side, e.clientX);
  };

  const onTrack = (e: React.PointerEvent<HTMLDivElement>) => {
    // Pressing the track moves the nearer thumb there and keeps
    // dragging it, which is what every other slider does.
    const frac = fractionAt(e.clientX);
    if (frac == null) return;
    const year = lo + frac * span;
    const side: Side = Math.abs(year - a) <= Math.abs(year - b) ? 'from' : 'to';
    const thumb = thumbs.current[side];
    thumb?.setPointerCapture?.(e.pointerId);
    thumb?.focus();
    drag(side, e.clientX);
  };

  const onKey = (side: Side, e: React.KeyboardEvent) => {
    const want = keyYear(side, e.key, { a, b, lo, hi });
    if (want === undefined) return;
    e.preventDefault();
    if (side === 'from') send(want, to);
    else send(from, want);
  };

  /** Where along the track a pointer is, as 0–1.
   *
   *  The drawn track is inset twelve pixels at each end so a thumb sitting
   *  on the last year is still fully on it. The maths has to use that
   *  same inset, or the years do not line up with the track under
   *  them and both ends are unreachable. */
  const fractionAt = (clientX: number): number | null => {
    const box = track.current?.getBoundingClientRect();
    const usable = (box?.width ?? 0) - TRACK_INSET * 2;
    if (!box || usable <= 0) return null;
    return Math.min(Math.max((clientX - box.left - TRACK_INSET) / usable, 0), 1);
  };

  const pct = (year: number) => ((year - lo) / span) * 100;
  /** A position along the drawn track, measured from the left edge or
   *  from the right, both inside the same inset. */
  const along = (fraction: number) =>
    `calc(${TRACK_INSET}px + (100% - ${TRACK_INSET * 2}px) * ${fraction})`;

  return (
    <div className="cd-range-wrap">
      <div
        className="cd-range"
        ref={track}
        aria-labelledby="cd-years-h"
        onPointerDown={onTrack}
        onPointerUp={onSettled}
      >
        {/* Coloured by where the thumbs are now, not by the settled
            range, so the years a drag takes in light up as it goes. */}
        {counts &&
          histBars(counts, lo, hi, a, b).map((bar) => (
            <span
              key={bar.year}
              className={`cd-range-bar${bar.inRange ? ' cd-range-bar-in' : ''}`}
              style={{ left: along(bar.at), height: bar.h }}
              aria-hidden="true"
            />
          ))}
        <div className="cd-range-track" />
        <div
          className="cd-range-fill"
          style={{ left: along(pct(a) / 100), right: along(1 - pct(b) / 100) }}
        />
        <Thumb
          side="from"
          label="From year"
          at={a}
          text={from == null ? 'Earliest' : String(from)}
          min={lo}
          max={b}
          offset={along(pct(a) / 100)}
          ref={(el) => {
            thumbs.current.from = el;
          }}
          onDown={startDrag}
          onMove={drag}
          onKey={onKey}
          onSettled={onSettled}
        />
        <Thumb
          side="to"
          label="To year"
          at={b}
          text={to == null ? 'Latest' : String(to)}
          min={a}
          max={hi}
          offset={along(pct(b) / 100)}
          ref={(el) => {
            thumbs.current.to = el;
          }}
          onDown={startDrag}
          onMove={drag}
          onKey={onKey}
          onSettled={onSettled}
        />
      </div>
      {/* The thumbs say their own years to a screen reader. */}
      <div className="cd-range-ends" aria-hidden="true">
        <span>{lo}</span>
        <span>{hi}</span>
      </div>
    </div>
  );
}

/** Where a key press puts a thumb, as the value that would be stored:
 *  a year, or null for the open end. `undefined` means the key was not
 *  one of ours and the page should keep it.
 *
 *  The two thumbs cannot cross, so each one is bounded by the other:
 *  End on the From thumb is the To year, not the last year on the map.
 */
export function keyYear(
  side: Side,
  key: string,
  { a, b, lo, hi }: { a: number; b: number; lo: number; hi: number },
): number | null | undefined {
  const step: Record<string, number> = {
    ArrowLeft: -1,
    ArrowDown: -1,
    ArrowRight: 1,
    ArrowUp: 1,
    PageDown: -PAGE,
    PageUp: PAGE,
  };
  let want: number;
  if (key in step) want = (side === 'from' ? a : b) + step[key];
  else if (key === 'Home') want = side === 'from' ? lo : a;
  else if (key === 'End') want = side === 'from' ? b : hi;
  else return undefined;
  // Inside the map, and never past the other thumb.
  want = Math.min(Math.max(want, lo), hi);
  want = side === 'from' ? Math.min(want, b) : Math.max(want, a);
  // A thumb at the end of the scale is that side left open.
  if (side === 'from') return want <= lo ? null : want;
  return want >= hi ? null : want;
}


function Thumb({
  side,
  label,
  at,
  text,
  min,
  max,
  offset,
  ref,
  onDown,
  onMove,
  onKey,
  onSettled,
}: {
  side: Side;
  label: string;
  at: number;
  text: string;
  min: number;
  max: number;
  /** Where it sits along the drawn track, already inside the inset. */
  offset: string;
  ref: (el: HTMLDivElement | null) => void;
  onDown: (side: Side, e: React.PointerEvent) => void;
  onMove: (side: Side, clientX: number) => void;
  onKey: (side: Side, e: React.KeyboardEvent) => void;
  onSettled: () => void;
}) {
  const held = useRef(false);
  return (
    <div
      className="cd-range-thumb"
      ref={ref}
      role="slider"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={at}
      aria-valuetext={text}
      tabIndex={0}
      style={{ left: offset }}
      onPointerDown={(e) => {
        held.current = true;
        onDown(side, e);
      }}
      onPointerMove={(e) => {
        if (held.current) onMove(side, e.clientX);
      }}
      onPointerUp={() => {
        held.current = false;
        onSettled();
      }}
      onPointerCancel={() => {
        held.current = false;
      }}
      onKeyDown={(e) => onKey(side, e)}
      onKeyUp={onSettled}
    />
  );
}

