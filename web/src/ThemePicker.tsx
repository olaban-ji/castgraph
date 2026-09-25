import { useRef, type ReactNode } from 'react';
import type { ThemePref } from './theme';

/** A screen, a sun and a moon. Drawn rather than written, because three
 *  words in a row this narrow either wrap or shrink to a size nobody
 *  reads — and these three are as close to universal as an icon gets.
 *
 *  The word is still there, as the label and the tooltip: what is lost
 *  from the screen is given back to the pointer and the screen reader. */
const ICON: Record<ThemePref, ReactNode> = {
  system: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  ),
  light: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  ),
  dark: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
    </svg>
  ),
};

const OPTIONS: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** The three-way theme choice, in the View panel and at the foot of the
 *  cold start — the two places a reader can be when they want it.
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
  return (
    <div className="cd-seg" role="radiogroup" aria-label="Theme">
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
          aria-label={o.label}
          title={o.label}
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
          {ICON[o.value]}
        </button>
      ))}
    </div>
  );
}
