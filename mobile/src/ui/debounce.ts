/**
 * 이력 search typing (audit I10): one search per pause instead of one per key, and
 * a sequence guard so a slower earlier search never draws over a newer one.
 */

export interface Debounced {
  call(): void;
  cancel(): void;
}

export function debounce(fn: () => void, ms: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    call(): void {
      cancel();
      timer = setTimeout(() => { timer = null; fn(); }, ms);
    },
    cancel,
  };
}

/** Tickets for async work: only the newest one may still apply its result. */
export class SeqGuard {
  private seq = 0;
  next(): number {
    this.seq += 1;
    return this.seq;
  }
  isCurrent(ticket: number): boolean {
    return ticket === this.seq;
  }
  /** Make every outstanding ticket stale. */
  invalidate(): void {
    this.seq += 1;
  }
}
