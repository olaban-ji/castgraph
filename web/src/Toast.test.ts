import { describe, expect, it } from 'vitest';
import { LEAVE_MS, TOAST_MS, toastClass } from './Toast';

describe('toast timing', () => {
  it('stays long enough to read and not so long it nags', () => {
    expect(TOAST_MS).toBe(3600);
  });

  it('leaves the tree once its exit has played', () => {
    // The handoff unmounts a hidden toast 260 ms after it starts to go,
    // which covers the .2s fade in the stylesheet.
    expect(LEAVE_MS).toBe(260);
  });
});

describe('toastClass', () => {
  it('rises clear of the floating buttons only on a map', () => {
    expect(toastClass(true, true)).toBe('cd-toast cd-toast-in cd-toast-map');
    expect(toastClass(true, false)).toBe('cd-toast cd-toast-in');
  });

  it('keeps its place while it leaves, so it does not drop on the way out', () => {
    expect(toastClass(false, true)).toBe('cd-toast cd-toast-map');
    expect(toastClass(false, false)).toBe('cd-toast');
  });
});
