import { useRef } from 'react';
import type { ThemePref } from './theme';

const OPTIONS: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** The three-way theme choice, in the View panel and at the foot of the
 *  cold start — the two places a reader can be when they want it. Three
 *  words: on the opening screen each has a fixed 76px segment, which is
 *  room enough that nothing wraps or shrinks.
 *
 *  A radiogroup rather than three buttons: there is one tab stop and the
 *  arrow keys move between the options, which is what a reader who is
 *  not using a pointer expects of a segmented control. */
export function ThemePicker({
  value,
  onChange,
}: {
  value: ThemePref;
  onChange: (p: ThemePref) => void;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (by: number) => {
    const at = OPTIONS.findIndex((o) => o.value === value);
    const to = (at + by + OPTIONS.length) % OPTIONS.length;
    onChange(OPTIONS[to].value);
    // The tab stop moves with the selection, so the focus has to follow
    // it or the next arrow press comes from nowhere.
    buttons.current[to]?.focus();
  };
  const at = Math.max(0, OPTIONS.findIndex((o) => o.value === value));
  return (
    <div className="cd-seg" role="radiogroup" aria-label="Theme">
      {/* One raised cell that moves, rather than three that light up in
          turn. The choice travels to where the reader pointed, which is
          the thing a segmented control is for. */}
      <span className="cd-seg-thumb" style={{ ['--at' as string]: at }} aria-hidden="true" />
      {OPTIONS.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            buttons.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          // One tab stop: the selected option is the one tab reaches,
          // and the arrows move from there.
          tabIndex={o.value === value ? 0 : -1}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
              e.preventDefault();
              move(1);
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
              e.preventDefault();
              move(-1);
            }
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
