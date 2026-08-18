/**
 * PRSprint 20 (docs/prsprints/PRSPRINT_20_IDEMPOTENCY_CONCURRENCY_FINANCIAL_STATE_SAFETY.md): a
 * minimal, dependency-free per-key async mutex — genuinely serializes concurrent callers sharing the
 * same key within one Node.js process, by chaining each call onto the previous holder's promise.
 *
 * This is NOT a substitute for a real cross-instance lock (a Postgres row lock via `SELECT ... FOR
 * UPDATE`, or an advisory lock) — a serverless deployment (this project's own Vercel target) may run
 * concurrent requests on entirely separate instances with no shared memory, where an in-process mutex
 * provides zero protection. Production code that needs cross-instance correctness (e.g.
 * `DrizzleAtomicManualPaymentPoster`) uses a real DB-level lock instead — see that class's doc
 * comment. This utility exists for exactly one purpose: letting the in-memory test fakes
 * (`InMemoryAtomicManualPaymentPoster`) genuinely serialize a locked critical section the same
 * logical way the real DB lock does, so a concurrent `Promise.all`-based test can actually prove the
 * race is closed, rather than accidentally passing only because the fake never modeled a race window
 * at all.
 */
export class KeyedMutex {
  private queues = new Map<string, Promise<unknown>>();

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(
      key,
      previous.then(() => current),
    );
    await previous;
    try {
      return await fn();
    } finally {
      release!();
    }
  }
}
