/**
 * Keeps checking native SMS send results while any send from this session still
 * has no final outcome. The carrier's sent-intent can arrive well after the
 * hand-off, and the store usually keeps the app open (no foreground return to
 * trigger a check), so a fixed ~5s/~30s check would leave a late failure showing
 * as '발송됨' all session. Bounded by a window after the latest send, so a result
 * that never arrives cannot poll forever. Timer/clock/visibility are injected.
 */

export interface ResultPollerDeps {
  /** Drain + apply native results (reconcileSendResults). Must not throw. */
  check: () => Promise<void>;
  /** True while the app is in front (checks are skipped in the background). */
  isVisible: () => boolean;
  setTimer: (fn: () => void, ms: number) => unknown;
  now: () => number;
}

export interface ResultPollerOptions {
  /** Delay of the first check after a send. */
  firstMs?: number;
  /** Delay between later checks. */
  intervalMs?: number;
  /** Stop polling this long after the latest tracked send. */
  windowMs?: number;
}

export class ResultPoller {
  private readonly ids = new Set<string>();
  private deadline = 0;
  private scheduled = false;
  private readonly firstMs: number;
  private readonly intervalMs: number;
  private readonly windowMs: number;

  constructor(private readonly deps: ResultPollerDeps, opts: ResultPollerOptions = {}) {
    this.firstMs = opts.firstMs ?? 5_000;
    this.intervalMs = opts.intervalMs ?? 10_000;
    this.windowMs = opts.windowMs ?? 180_000;
  }

  /** Sends still awaiting a native result. */
  get pending(): number {
    return this.ids.size;
  }

  /** Start (or extend) polling for a just-handed-off send id. */
  track(id: string): void {
    if (!id) return;
    this.ids.add(id);
    this.deadline = this.deps.now() + this.windowMs;
    if (!this.scheduled) this.schedule(this.firstMs);
  }

  /** Forget ids whose native result has been applied. */
  settle(ids: Iterable<string>): void {
    for (const id of ids) this.ids.delete(id);
  }

  private schedule(ms: number): void {
    this.scheduled = true;
    this.deps.setTimer(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    this.scheduled = false;
    if (!this.ids.size) return;
    if (this.deps.isVisible()) {
      try {
        await this.deps.check();
      } catch {
        /* results stay queued natively; the next tick retries */
      }
    }
    if (!this.ids.size) return;
    if (this.deps.now() >= this.deadline) {
      this.ids.clear(); // give up; a foreground return / boot still reconciles
      return;
    }
    if (!this.scheduled) this.schedule(this.intervalMs);
  }
}
