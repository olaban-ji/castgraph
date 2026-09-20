import { describe, expect, it } from 'vitest';
import { isDragPanStart } from './pan';

describe('isDragPanStart', () => {
  it('accepts ⌘ or ctrl with the primary button', () => {
    expect(isDragPanStart({ button: 0, ctrlKey: true, metaKey: false })).toBe(true);
    expect(isDragPanStart({ button: 0, ctrlKey: false, metaKey: true })).toBe(true);
  });

  it('ignores a click with no modifier, and other mouse buttons', () => {
    expect(isDragPanStart({ button: 0, ctrlKey: false, metaKey: false })).toBe(false);
    expect(isDragPanStart({ button: 2, ctrlKey: true, metaKey: false })).toBe(false);
    expect(isDragPanStart({ button: 1, ctrlKey: false, metaKey: true })).toBe(false);
  });

  it('leaves finger touches to native scrolling', () => {
    expect(
      isDragPanStart({ button: 0, ctrlKey: true, metaKey: false, pointerType: 'touch' }),
    ).toBe(false);
    expect(
      isDragPanStart({ button: 0, ctrlKey: false, metaKey: true, pointerType: 'mouse' }),
    ).toBe(true);
  });
});
