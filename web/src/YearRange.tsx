import { useEffect, useRef, useState } from 'react';

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
  /** Called once the change is settled: pointer up, key up, or a field
   *  committed. The map is put back on the searched film then, not on
   *  every year the thumb passes over. */
  onSettled: () => void;
}

/** Which thumb is being moved. */
type Side = 'from' | 'to';

/** How far a PageUp moves. */
const PAGE = 10;

/** The year range: a two-thumb slider and two fields that say the same
 *  thing in numbers.
 *
 *  Two divs with `role="slider"` rather than two stacked `<input
 *  type="range">`: stacked native ranges fight over the pointer, and in
 *  Safari the one on top takes every press whichever thumb was aimed at.
 *
 *  A range from end to end is no range at all, so a thumb that reaches
 *  a bound opens that side. Otherwise the reader would have to know
 *  that 1931–2024 and "all years" are the same thing. */
export function YearRange({ lo, hi, from, to, onChange, onSettled }: Props) {
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
    const box = track.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const frac = Math.min(Math.max((clientX - box.left) / box.width, 0), 1);
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
    const box = track.current?.getBoundingClientRect();
    if (!box) return;
    const frac = (e.clientX - box.left) / box.width;
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

  const pct = (year: number) => ((year - lo) / span) * 100;

  return (
    <div className="cd-range-wrap">
      <div
        className="cd-range"
        ref={track}
        aria-labelledby="cd-years-h"
        onPointerDown={onTrack}
        onPointerUp={onSettled}
      >
        <div className="cd-range-track" />
        <div
          className="cd-range-fill"
          style={{ left: `${pct(a)}%`, right: `${100 - pct(b)}%` }}
        />
        <Thumb
          side="from"
          label="From year"
          at={a}
          text={from == null ? 'Earliest' : String(from)}
          min={lo}
          max={b}
          pct={pct(a)}
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
          pct={pct(b)}
          ref={(el) => {
            thumbs.current.to = el;
          }}
          onDown={startDrag}
          onMove={drag}
          onKey={onKey}
          onSettled={onSettled}
        />
      </div>
      <div className="cd-range-fields">
        <Field
          label="From"
          value={from}
          placeholder={lo}
          onCommit={(v) => {
            onChange(...ordered(v, to, lo, hi));
            onSettled();
          }}
        />
        <span className="cd-range-dash" aria-hidden="true">
          –
        </span>
        <Field
          label="To"
          value={to}
          placeholder={hi}
          onCommit={(v) => {
            onChange(...ordered(from, v, lo, hi));
            onSettled();
          }}
        />
        <span className="cd-range-bounds">
          {lo}–{hi}
        </span>
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

/** A committed pair, clamped to the map and put the right way round.
 *  Typing 2010 into From when To says 2000 means those two years, not
 *  an empty map. */
export function ordered(
  from: number | null,
  to: number | null,
  lo: number,
  hi: number,
): [number | null, number | null] {
  const clamp = (v: number | null) => (v == null ? null : Math.min(Math.max(v, lo), hi));
  let a = clamp(from);
  let b = clamp(to);
  if (a != null && b != null && a > b) [a, b] = [b, a];
  // An end that reaches the bound is the same as no end at all.
  return [a != null && a <= lo ? null : a, b != null && b >= hi ? null : b];
}

function Thumb({
  side,
  label,
  at,
  text,
  min,
  max,
  pct,
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
  pct: number;
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
      style={{ left: `${pct}%` }}
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

function Field({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: number | null;
  placeholder: number;
  onCommit: (v: number | null) => void;
}) {
  // Typing does not commit. A reader half way through "2005" has
  // written "20", and relaying the map on it would empty the screen.
  const [typed, setTyped] = useState<string | null>(null);
  const shown = typed ?? (value == null ? '' : String(value));
  const commit = () => {
    if (typed === null) return;
    const trimmed = typed.trim();
    setTyped(null);
    onCommit(trimmed === '' ? null : Number(trimmed));
  };
  return (
    <label className="cd-range-field">
      <span className="cd-range-field-label">{label}</span>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={4}
        value={shown}
        placeholder={String(placeholder)}
        onChange={(e) => setTyped(e.target.value.replace(/\D/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </label>
  );
}
