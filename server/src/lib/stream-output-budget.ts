/** Tracks the cumulative UTF-8 payload retained by one upstream chat stream. */
export class StreamOutputBudget {
  private usedBytes = 0;

  constructor(readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError('Stream output byte limit must be a positive safe integer');
    }
  }

  add(value: string): void {
    const next = this.usedBytes + Buffer.byteLength(value, 'utf8');
    if (next > this.maxBytes) {
      throw new Error(`provider stream exceeded the ${this.maxBytes}-byte output safety limit`);
    }
    this.usedBytes = next;
  }

  get bytes(): number {
    return this.usedBytes;
  }
}
