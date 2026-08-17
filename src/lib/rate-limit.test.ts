import { beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/lib/logger";
import { checkRateLimit, resetRateLimits, InMemoryRateLimitStore, DrizzleRateLimitStore } from "./rate-limit";

describe("checkRateLimit", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it("allows requests up to the limit within the window", async () => {
    const now = 1_000_000;
    expect(await checkRateLimit("k", 3, 60_000, now)).toBe(true);
    expect(await checkRateLimit("k", 3, 60_000, now)).toBe(true);
    expect(await checkRateLimit("k", 3, 60_000, now)).toBe(true);
  });

  it("blocks the request that exceeds the limit within the window", async () => {
    const now = 1_000_000;
    await checkRateLimit("k", 2, 60_000, now);
    await checkRateLimit("k", 2, 60_000, now);
    expect(await checkRateLimit("k", 2, 60_000, now)).toBe(false);
  });

  it("resets the count once the window has elapsed", async () => {
    const start = 1_000_000;
    await checkRateLimit("k", 1, 60_000, start);
    expect(await checkRateLimit("k", 1, 60_000, start)).toBe(false);
    expect(await checkRateLimit("k", 1, 60_000, start + 60_001)).toBe(true);
  });

  it("tracks separate keys independently", async () => {
    const now = 1_000_000;
    await checkRateLimit("a", 1, 60_000, now);
    expect(await checkRateLimit("a", 1, 60_000, now)).toBe(false);
    expect(await checkRateLimit("b", 1, 60_000, now)).toBe(true);
  });

  /**
   * PRSprint 11A (docs/prsprints/PRSPRINT_11A_LOGIN_AUTHENTICATION_REGRESSION_REMEDIATION.md): proves
   * the fail-open fix that restores login/signup availability when the rate_limit_bucket store itself
   * errors (the actual production root cause of the reported login regression — see that PRSprint's
   * doc for the full trace). Before this fix, a store error propagated straight out of checkRateLimit
   * and every route that calls it unconditionally before doing anything else — most critically login
   * and signup — returned a 500 instead of ever reaching password verification.
   */
  it("fails open (allows the request) when the store itself throws, instead of propagating the error", async () => {
    const store = resetRateLimits();
    store.failNext = true;
    await expect(checkRateLimit("login:ip:1.2.3.4", 10, 60_000, 1_000_000)).resolves.toBe(true);
  });

  it("logs the store failure at error level, distinct from the normal rate_limit_exceeded warn log, and does not leak the raw key", async () => {
    const store = resetRateLimits();
    store.failNext = true;
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    await checkRateLimit("login:ip:1.2.3.4", 10, 60_000, 1_000_000);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, context] = errorSpy.mock.calls[0]!;
    expect(message).toBe("rate_limit_store_unavailable");
    expect(context).toMatchObject({ namespace: "login" });
    expect(JSON.stringify(context)).not.toContain("1.2.3.4");
    errorSpy.mockRestore();
  });

  /**
   * PRSprint 12A (docs/prsprints/PRSPRINT_12A_PRODUCTION_DATABASE_RECONCILIATION.md): PRSprint 11A's
   * own report explicitly flagged that Drizzle's top-level error message ("Failed query: <sql>")
   * never surfaced the actual underlying Postgres error (SQLSTATE code, detail, which table/
   * constraint) that lives one level down on `.cause` — this is exactly what live production log
   * capture during this PRSprint needed and didn't have. Proves the fix logs it.
   */
  it("surfaces the underlying Postgres error's code/detail/table from .cause, not just Drizzle's generic wrapper message", async () => {
    const store = resetRateLimits();
    const causeError = Object.assign(new Error("relation \"rate_limit_bucket\" does not exist"), {
      name: "PostgresError",
      code: "42P01",
      table_name: undefined,
      detail: undefined,
    });
    store.failNext = true;
    store.failNextWith = new Error("Failed query: INSERT INTO ...", { cause: causeError });
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    await checkRateLimit("signup:ip:9.9.9.9", 10, 60_000, 1_000_000);
    const [, context] = errorSpy.mock.calls[0]!;
    expect(context).toMatchObject({
      namespace: "signup",
      causeName: "PostgresError",
      causeCode: "42P01",
      causeMessage: 'relation "rate_limit_bucket" does not exist',
    });
    errorSpy.mockRestore();
  });

  it("recovers on the next call once the store stops failing — a single transient error does not permanently disable rate limiting", async () => {
    const store = resetRateLimits();
    store.failNext = true;
    const now = 1_000_000;
    expect(await checkRateLimit("k", 1, 60_000, now)).toBe(true); // store failure, fails open
    expect(await checkRateLimit("k", 1, 60_000, now)).toBe(true); // store healthy again, first real increment
    expect(await checkRateLimit("k", 1, 60_000, now)).toBe(false); // over the limit now, correctly blocked
  });
});

describe("InMemoryRateLimitStore", () => {
  it("increments a fresh key to 1", async () => {
    const store = new InMemoryRateLimitStore();
    expect(await store.incrementAndCheck("x", 60_000, 1_000_000)).toBe(1);
  });

  it("increments an existing key within its window", async () => {
    const store = new InMemoryRateLimitStore();
    await store.incrementAndCheck("x", 60_000, 1_000_000);
    expect(await store.incrementAndCheck("x", 60_000, 1_000_100)).toBe(2);
  });

  it("resets to 1 once the window has elapsed", async () => {
    const store = new InMemoryRateLimitStore();
    await store.incrementAndCheck("x", 60_000, 1_000_000);
    expect(await store.incrementAndCheck("x", 60_000, 1_061_001)).toBe(1);
  });

  it("clear() resets all keys", async () => {
    const store = new InMemoryRateLimitStore();
    await store.incrementAndCheck("x", 60_000, 1_000_000);
    store.clear();
    expect(await store.incrementAndCheck("x", 60_000, 1_000_100)).toBe(1);
  });
});

describe("DrizzleRateLimitStore", () => {
  it(
    "issues exactly one atomic upsert statement per call — never a separate read then write, " +
      "which is what makes concurrent requests from different serverless instances safe (Postgres " +
      "serializes concurrent INSERT ... ON CONFLICT DO UPDATE on the same key via row-level locking; " +
      "a read-then-write pair would instead let two concurrent requests both read the same " +
      "pre-update count and both increment from it, undercounting)",
    async () => {
      const executedStatements: string[] = [];
      const fakeDb = {
        execute: async (query: { queryChunks: unknown[] }) => {
          // The `sql` template tag builds a `queryChunks` array alternating literal-SQL `StringChunk`
          // objects (each exposing a `value: string[]`) with parameter/placeholder chunks for bound
          // values — joining just the StringChunk text reconstructs the statement's literal SQL
          // shape without depending on any dialect-specific compile step, and proves this is one
          // statement issued once, not a sequence of separate queries.
          const compiled = query.queryChunks
            .filter((chunk): chunk is { value: string[] } => {
              const candidate = chunk as { value?: unknown };
              return Array.isArray(candidate.value) && candidate.value.every((v) => typeof v === "string");
            })
            .flatMap((chunk) => chunk.value)
            .join(" ");
          executedStatements.push(compiled);
          return [{ count: 1 }];
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const store = new DrizzleRateLimitStore(fakeDb);
      await store.incrementAndCheck("k", 60_000, 1_000_000);

      expect(executedStatements).toHaveLength(1);
      expect(executedStatements[0]).toContain("INSERT INTO");
      expect(executedStatements[0]).toContain("ON CONFLICT");
      expect(executedStatements[0]).toContain("DO UPDATE");
    },
  );

  it("returns the count from the upsert's RETURNING clause", async () => {
    const fakeDb = {
      execute: async () => [{ count: 7 }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const store = new DrizzleRateLimitStore(fakeDb);
    expect(await store.incrementAndCheck("k", 60_000, 1_000_000)).toBe(7);
  });
});
