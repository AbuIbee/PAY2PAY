import { NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "@/lib/errors";
import { withErrorHandling } from "./api-handler";

/**
 * PRSprint 28 (docs/prsprints/PRSPRINT_28_ERROR_HANDLING_OBSERVABILITY_HEALTH_MONITORING.md):
 * "Users should receive a stable user-facing error identifier/correlation ID where useful" — proves
 * the split: a genuine server fault gets one, a routine 4xx rejection does not.
 */
describe("withErrorHandling", () => {
  it("passes through a successful response unchanged", async () => {
    const handler = withErrorHandling("test_route", async () => NextResponse.json({ ok: true }, { status: 200 }));
    const response = await handler();
    expect(response.status).toBe(200);
  });

  it("does not attach a correlationId to an ordinary validation error (4xx)", async () => {
    const handler = withErrorHandling("test_route", async () => {
      throw new ValidationError("Bad input.");
    });
    const response = await handler();
    const body = (await response.json()) as { status: string; code: string; message: string; correlationId?: string };
    expect(response.status).toBe(400);
    expect(body.message).toBe("Bad input.");
    expect(body.correlationId).toBeUndefined();
  });

  it("attaches a correlationId to an unexpected internal failure (5xx), never leaking the raw error message", async () => {
    const handler = withErrorHandling("test_route", async () => {
      throw new Error("raw internal detail that must never reach the client");
    });
    const response = await handler();
    const body = (await response.json()) as { status: string; code: string; message: string; correlationId?: string };
    expect(response.status).toBe(500);
    expect(body.message).not.toContain("raw internal detail");
    expect(body.correlationId).toBeTruthy();
    // A valid UUID, not a guessable/sequential value.
    expect(body.correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("generates a different correlationId for each failure (never reused/predictable)", async () => {
    const handler = withErrorHandling("test_route", async () => {
      throw new Error("boom");
    });
    const first = (await (await handler()).json()) as { correlationId: string };
    const second = (await (await handler()).json()) as { correlationId: string };
    expect(first.correlationId).not.toBe(second.correlationId);
  });

  it("Agreement Lifecycle V2 UAT (Send secure invitation 'Unexpected error occurred'): logs error.cause server-side — a wrapped driver/ORM error's own .message (e.g. drizzle's 'Failed query: ...') hides the real underlying failure otherwise", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const handler = withErrorHandling("test_route", async () => {
        const outer = new Error("Failed query: insert into ...");
        outer.cause = Object.assign(new Error('invalid input syntax for type uuid: ""'), { code: "22P02" });
        throw outer;
      });
      await handler();
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(consoleErrorSpy.mock.calls[0]?.[0] as string) as {
        causeName?: string;
        causeMessage?: string;
        causeCode?: string;
      };
      expect(logged.causeMessage).toBe('invalid input syntax for type uuid: ""');
      expect(logged.causeCode).toBe("22P02");
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("never logs a cause field when the error has none (no undefined noise in the log line)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const handler = withErrorHandling("test_route", async () => {
        throw new Error("plain failure, no cause");
      });
      await handler();
      const logged = JSON.parse(consoleErrorSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
      expect("causeMessage" in logged).toBe(false);
      expect("cause" in logged).toBe(false);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
