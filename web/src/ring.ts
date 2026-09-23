/** Which map to draw. The revamp is the default on this branch; the map
 *  that grew hop by hop is still reachable at `?view=map` until §1's
 *  demolition removes it. */
export type View = 'grid' | 'map';

export function viewOf(search = window.location.search): View {
  return new URLSearchParams(search).get('view') === 'map' ? 'map' : 'grid';
}
