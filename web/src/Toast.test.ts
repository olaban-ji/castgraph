import { describe, expect, it } from 'vitest';
import { TOAST_MS } from './Toast';

describe('toast timing', () => {
  it('stays long enough to read and not so long it nags', () => {
    expect(TOAST_MS).toBe(3600);
  });
});
