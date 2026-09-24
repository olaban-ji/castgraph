import { describe, expect, it } from 'vitest';
import { closesOn, CLOSE_AT, dragOffset, ENTER_MS, EXIT_MS } from './sheet';

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

  it('gives the exit longer than the .28s it is drawn over', () => {
    expect(EXIT_MS).toBeGreaterThanOrEqual(280);
  });
});
