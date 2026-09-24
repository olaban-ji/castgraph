import type { Trace } from './trace';

interface Props {
  trace: Trace;
  /** Which stop on the route the camera is showing. */
  stopAt: number;
  onStop: (index: number) => void;
  /** False in the phone column, where the whole route is already a list
   *  and there is no camera to travel with. */
  canStep: boolean;
  /** Narrow the map to this person instead of only highlighting them. */
  onlyThis: boolean;
  onOnlyThis: (only: boolean) => void;
  onClear: () => void;
}

/** A trace is a standing question, not a passing one: it survives
 *  scrolling, so it needs to say it is on and offer a way out. */
export function TraceBar({ trace, stopAt, onStop, canStep, onlyThis, onOnlyThis, onClear }: Props) {
  const stops = trace.stops.length;
  return (
    <div className="mc-trace-bar" role="status">
      <span className="mc-trace-dot" aria-hidden="true" />
      <span className="mc-trace-text">
        Following <strong>{trace.person}</strong>
      </span>
      {canStep && stops > 1 && (
        <span className="mc-trace-step">
          <button
            type="button"
            className="mc-trace-arrow"
            aria-label="Previous movie on the route"
            onClick={() => onStop(stopAt - 1)}
          >
            ←
          </button>
          <button
            type="button"
            className="mc-trace-arrow"
            aria-label="Next movie on the route"
            onClick={() => onStop(stopAt + 1)}
          >
            →
          </button>
        </span>
      )}
      <button
        type="button"
        className={`mc-trace-only${onlyThis ? ' mc-trace-only-on' : ''}`}
        aria-pressed={onlyThis}
        onClick={() => onOnlyThis(!onlyThis)}
      >
        Hide everything else
      </button>
      <button type="button" className="mc-trace-clear" onClick={onClear}>
        Clear
      </button>
    </div>
  );
}
