import {
  useEffect,
  useRef,
  type ReactNode,
  type RefObject,
  type WheelEvent,
} from 'react';
import type { GridPerson } from './grid';
import { useHoverDelay, useTapGuard } from './tap';

interface Props {
  people: GridPerson[];
  selected: Set<string>;
  /** People on the card the pointer is resting on, which lights their chips. */
  lit: Set<string>;
  onToggle: (id: string) => void;
  onHover: (id: string | null) => void;
  onClear: () => void;
  /** Rendered before "Everyone": the active-filter pill, when there is
   *  one. Nothing that hides content may be invisible. */
  lead?: ReactNode;
  /** The "Everyone" chip, so focus has somewhere to land when the pill
   *  before it is cleared away. */
  allRef?: RefObject<HTMLButtonElement | null>;
}

/** The tone a person is drawn in: cast gold, directors green. It is the
 *  only thing colour means on this screen.
 *
 *  Both are tokens, so both darken on paper: brand gold on white is a
 *  smudge rather than a dot. */
export function toneOf(role: GridPerson['role']): string {
  return role === 'director' ? 'var(--director)' : 'var(--cast)';
}

/** One line of chips: everyone, then each person in billing order. A chip
 *  selects that person; the grid dims everything they are not in. */
export function PeopleChips({
  people,
  selected,
  lit,
  onToggle,
  onHover,
  onClear,
  lead,
  allRef,
}: Props) {
  useEffect(() => () => onHover(null), [onHover]);
  const row = useRef<HTMLDivElement>(null);
  // The strip scrolls sideways, so the same rule the map uses applies:
  // a chip that ends a flick was not chosen.
  const tap = useTapGuard();
  // And a pointer crossing the row on its way elsewhere should not make
  // the whole map flash. It has to stop on a chip to mean it.
  const rest = useHoverDelay(onHover);
  return (
    <div
      className="cd-chips"
      ref={row}
      onMouseLeave={rest.leave}
      onPointerDown={tap.onPointerDown}
      onPointerMove={tap.onPointerMove}
      onScroll={tap.onScroll}
      onWheel={(e) => wheelSideways(e, row.current)}
    >
      {lead}
      <button
        type="button"
        ref={allRef}
        className={`cd-chip cd-chip-all${selected.size === 0 ? ' cd-chip-on' : ''}`}
        onClick={() => tap.allows() && onClear()}
      >
        Everyone
      </button>
      {people.map((p) => {
        const on = selected.has(p.id);
        return (
          <button
            key={p.id}
            type="button"
            className={`cd-chip${on ? ' cd-chip-on' : ''}${lit.has(p.id) ? ' cd-chip-lit' : ''}`}
            style={{ ['--tone' as string]: toneOf(p.role) }}
            aria-pressed={on}
            onClick={() => tap.allows() && onToggle(p.id)}
            onMouseEnter={() => rest.enter(p.id)}
            onMouseLeave={rest.leave}
          >
            <span className="cd-chip-dot" aria-hidden="true" />
            <span className="cd-chip-name">{p.name}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A wheel over the chips moves them sideways.
 *
 *  A mouse wheel and a trackpad's vertical flick both send deltaY, and a
 *  row that only scrolls horizontally does nothing with it — so on a
 *  desktop the chips past the edge could only be reached by dragging.
 *  A horizontal gesture already works and is left alone. */
function wheelSideways(e: WheelEvent<HTMLDivElement>, row: HTMLDivElement | null) {
  if (!row || e.deltaX !== 0 || e.deltaY === 0) return;
  const room = row.scrollWidth - row.clientWidth;
  if (room <= 0) return;
  // Not past either end: the page behind should still scroll when the
  // row has nowhere left to go.
  const to = Math.min(Math.max(row.scrollLeft + e.deltaY, 0), room);
  if (to === row.scrollLeft) return;
  e.preventDefault();
  row.scrollLeft = to;
}

/** How many films on the grid each person is in. */
export function filmCounts(films: { people: string[] }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of films) {
    // Once per film: a person credited twice is still one card.
    for (const id of new Set(f.people)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}
