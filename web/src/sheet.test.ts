import { describe, expect, it } from 'vitest';
import { closesOn, CLOSE_AT, dragOffset, ENTER_MS, exitDelay, SHEET_EXIT_MS, VIEW_EXIT_MS } from './sheet';

describe('dragOffset', () => {
  it('follows a finger going down', () => {
    expect(dragOffset(100, 180)).toBe(80);
  });

  it('ignores a finger going up: the sheet is already at the bottom', () => {
    expect(dragOffset(100, 20)).toBe(0);
  });
});

describe('closesOn', () => {
  it('springs back on a short pull', () => {
    expect(closesOn(0)).toBe(false);
    expect(closesOn(CLOSE_AT)).toBe(false);
  });

  it('closes on a long one', () => {
    expect(closesOn(CLOSE_AT + 1)).toBe(true);
  });
});

describe('the glide', () => {
  it('lets a layer mount before it is let in', () => {
    expect(ENTER_MS).toBeGreaterThan(0);
  });

  // Each layer waits exactly as long as the exit its stylesheet draws:
  // .28s for the film sheet, .26s for the View panel. The one shared
  // 300 ms this replaced held the next step back for a beat after the
  // sheet had already gone, and the move to another map starts on it.
  it('waits for the film sheet as long as its .28s exit', () => {
    expect(SHEET_EXIT_MS).toBe(280);
  });

  it('waits for the View panel as long as its .26s exit', () => {
    expect(VIEW_EXIT_MS).toBe(260);
  });

  it('does not wait at all for a reader who has asked for no motion', () => {
    expect(exitDelay(SHEET_EXIT_MS, true)).toBe(0);
    expect(exitDelay(VIEW_EXIT_MS, true)).toBe(0);
    expect(exitDelay(SHEET_EXIT_MS, false)).toBe(280);
  });
});
