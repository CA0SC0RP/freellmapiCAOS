import { describe, it, expect, beforeEach } from 'vitest';
import {
  TOOL_BENCH_MS,
  TOOL_REJECTION_LIMIT,
  TOOL_REJECTION_WINDOW_MS,
  benchForTools,
  clearToolRejections,
  isToolBenched,
  noteToolRejection,
  resetToolCapability,
  toolCapabilityKey,
} from '../../lib/tool-capability.js';

describe('tool capability rejection memory', () => {
  beforeEach(() => resetToolCapability());

  const platform = 'custom';
  const model = 'relay-model';
  const endpoint = 'https://relay.example/v1';
  const key = () => toolCapabilityKey(platform, model, endpoint);

  it('defers only after the configured number of rejected requests', () => {
    const now = 10_000;
    for (let i = 0; i < TOOL_REJECTION_LIMIT - 1; i++) {
      noteToolRejection(key(), now + i);
      expect(isToolBenched(platform, model, endpoint, now + i)).toBe(false);
    }

    noteToolRejection(key(), now + TOOL_REJECTION_LIMIT);
    expect(isToolBenched(platform, model, endpoint, now + TOOL_REJECTION_LIMIT)).toBe(true);
  });

  it('drops rejections outside the rolling evidence window', () => {
    const now = 20_000;
    noteToolRejection(key(), now);
    noteToolRejection(key(), now + TOOL_REJECTION_WINDOW_MS + 1);
    noteToolRejection(key(), now + TOOL_REJECTION_WINDOW_MS + 2);

    expect(isToolBenched(platform, model, endpoint, now + TOOL_REJECTION_WINDOW_MS + 2)).toBe(false);
  });

  it('automatically restores the model when the bench expires', () => {
    const now = 30_000;
    benchForTools(key(), now);

    expect(isToolBenched(platform, model, endpoint, now + TOOL_BENCH_MS - 1)).toBe(true);
    expect(isToolBenched(platform, model, endpoint, now + TOOL_BENCH_MS)).toBe(false);
  });

  it('clears rejection history and an active bench after a successful tool request', () => {
    const now = 40_000;
    noteToolRejection(key(), now);
    benchForTools(key(), now + 1);
    clearToolRejections(key());

    expect(isToolBenched(platform, model, endpoint, now + 2)).toBe(false);
    for (let i = 0; i < TOOL_REJECTION_LIMIT - 1; i++) {
      noteToolRejection(key(), now + 3 + i);
    }
    expect(isToolBenched(platform, model, endpoint, now + TOOL_REJECTION_LIMIT + 3)).toBe(false);
  });

  it('keeps evidence isolated by endpoint scope', () => {
    const now = 50_000;
    const otherEndpoint = 'https://other-relay.example/v1';
    benchForTools(key(), now);

    expect(isToolBenched(platform, model, endpoint, now + 1)).toBe(true);
    expect(isToolBenched(platform, model, otherEndpoint, now + 1)).toBe(false);
  });
});
