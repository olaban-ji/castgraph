import { useRef } from 'react';
import { RATING_STOPS, type GridSettings } from './grid';
import { useScreen } from './screen';
import { useDrag, useEscape, useFocusTrapped, useGlide } from './sheet';

/** What the reader can change about how the map is drawn. The order is
 *  the order of the switches. */
const SWITCHES: { key: keyof GridSettings; label: string; on: (s: GridSettings) => boolean; set: (s: GridSettings, on: boolean) => GridSettings }[] = [
  {
    key: 'density',
    label: 'Compact cards',
    on: (s) => s.density === 'compact',
    set: (s, on) => ({ ...s, density: on ? 'compact' : 'comfortable' }),
  },
  {
    key: 'yearOrder',
    label: 'Newest first',
    on: (s) => s.yearOrder === 'newest',
    set: (s, on) => ({ ...s, yearOrder: on ? 'newest' : 'oldest' }),
  },
  {
    key: 'showUnrated',
    label: 'Show unrated movies',
    on: (s) => s.showUnrated,
    set: (s, on) => ({ ...s, showUnrated: on }),
  },
  {
    key: 'highlightYear',
    label: 'Highlight the searched year',
    on: (s) => s.highlightYear,
    set: (s, on) => ({ ...s, highlightYear: on }),
  },
];

/** Which settings pull the plot out from under the reader, so the map
 *  has to be put back on the searched film afterwards. */
export function movesTheMap(key: keyof GridSettings): boolean {
  return key === 'yearOrder' || key === 'showUnrated';
}

interface Props {
  settings: GridSettings;
  onChange: (s: GridSettings) => void;
  /** Called after a change that rearranges the plot. */
  onRelaid: () => void;
  /** The rating rungs live here on a phone, where the header has no room. */
  rungs: boolean;
  onFloor: (r: number | null) => void;
  onClose: () => void;
}

/** A popover on a desktop and a bottom sheet on a phone, arriving and
 *  leaving the same way the film panel does. */
export function ViewPanel({ settings, onChange, onRelaid, rungs, onFloor, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const { phone } = useScreen();
  const { phase, leave } = useGlide(onClose);
  const drag = useDrag(phone, leave);
  useEscape(leave);
  useFocusTrapped(ref);
  const held = drag.held && drag.y > 0;

  return (
    <>
      <div
        className={`cd-view-scrim${phone ? ' cd-view-scrim-dim' : ''}${phase === 'in' ? ' cd-view-scrim-in' : ''}`}
        onClick={() => leave()}
        aria-hidden="true"
      />
      <div
        className={`cd-view cd-view-${phase}`}
        style={held ? { transform: `translateY(${drag.y}px)`, transition: 'none' } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label="View"
        tabIndex={-1}
        ref={ref}
      >
        <span
          className="cd-sheet-grip"
          aria-hidden="true"
          onPointerDown={drag.onPointerDown}
          onPointerMove={drag.onPointerMove}
          onPointerUp={drag.onPointerUp}
          onPointerCancel={drag.onPointerUp}
        />
        {rungs && (
          <div className="cd-view-section">
            <div className="cd-view-heading">Light movies rated at least</div>
            <div className="cd-view-rungs" role="group" aria-label="Light movies by rating">
              <Rung on={settings.minRating == null} label="Any" onPick={() => onFloor(null)} />
              {RATING_STOPS.map((r) => (
                <Rung
                  key={r}
                  on={settings.minRating === r}
                  label={r.toFixed(1)}
                  aria={`Light movies rated at least ${r.toFixed(1)}`}
                  onPick={() => onFloor(settings.minRating === r ? null : r)}
                />
              ))}
            </div>
          </div>
        )}
        <div className="cd-view-section">
          {SWITCHES.map((sw) => (
            <button
              key={sw.key}
              type="button"
              className="cd-switch"
              role="switch"
              aria-checked={sw.on(settings)}
              onClick={() => {
                onChange(sw.set(settings, !sw.on(settings)));
                if (movesTheMap(sw.key)) onRelaid();
              }}
            >
              <span className="cd-switch-label">{sw.label}</span>
              <span className="cd-switch-track" aria-hidden="true">
                <span className="cd-switch-knob" />
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function Rung({
  on,
  label,
  aria,
  onPick,
}: {
  on: boolean;
  label: string;
  aria?: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      className={`cd-rung${on ? ' cd-rung-on' : ''}`}
      aria-pressed={on}
      aria-label={aria}
      onClick={onPick}
    >
      {label}
    </button>
  );
}
