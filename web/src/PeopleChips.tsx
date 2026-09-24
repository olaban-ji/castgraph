import { useEffect } from 'react';
import type { GridPerson } from './grid';
import { useHoverDelay, useTapGuard } from './tap';

interface Props {
  people: GridPerson[];
  selected: Set<number>;
  /** People on the card the pointer is resting on, which lights their chips. */
  lit: Set<number>;
  onToggle: (id: number) => void;
  onHover: (id: number | null) => void;
  onClear: () => void;
}

/** The tone a person is drawn in: cast gold, directors green. It is the
 *  only thing colour means on this screen. */
export function toneOf(role: GridPerson['role']): string {
  return role === 'director' ? 'var(--director)' : 'var(--accent)';
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
}: Props) {
  useEffect(() => () => onHover(null), [onHover]);
  // The strip scrolls sideways, so the same rule the map uses applies:
  // a chip that ends a flick was not chosen.
  const tap = useTapGuard();
  // And a pointer crossing the row on its way elsewhere should not make
  // the whole map flash. It has to stop on a chip to mean it.
  const rest = useHoverDelay(onHover);
  return (
    <div
      className="cd-chips"
      onMouseLeave={rest.leave}
      onPointerDown={tap.onPointerDown}
      onPointerMove={tap.onPointerMove}
      onScroll={tap.onScroll}
    >
      <button
        type="button"
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

/** How many films on the grid each person is in. */
export function filmCounts(films: { people: number[] }[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const f of films) {
    // Once per film: a person credited twice is still one card.
    for (const id of new Set(f.people)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}
