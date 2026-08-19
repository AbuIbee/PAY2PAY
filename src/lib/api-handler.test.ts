import { NextResponse } from "next/server";
import { describe, expect, it } from "vitest";
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
});
