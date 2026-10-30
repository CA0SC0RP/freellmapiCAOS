import { describe, expect, it } from 'vitest';
import { StreamOutputBudget } from '../../lib/stream-output-budget.js';

describe('StreamOutputBudget', () => {
  it('counts UTF-8 bytes cumulatively rather than JavaScript characters', () => {
    const budget = new StreamOutputBudget(8);
    budget.add('abcd');
    budget.add('ñ');
    expect(budget.bytes).toBe(6);
    expect(() => budget.add('🙂')).toThrow(/8-byte output safety limit/);
    expect(budget.bytes).toBe(6);
  });

  it('rejects a single chunk that exceeds the full budget', () => {
    const budget = new StreamOutputBudget(4);
    expect(() => budget.add('12345')).toThrow(/4-byte output safety limit/);
    expect(budget.bytes).toBe(0);
  });

  it('rejects invalid configured limits', () => {
    for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() => new StreamOutputBudget(limit)).toThrow(RangeError);
    }
  });
});
