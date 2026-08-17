import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { createTestNotificationService } from "@/lib/notify/testFakes";
import { createSmsInboundWebhookHandler } from "./route";

const AUTH_TOKEN = "twilio_test_auth_token_0123456789";
// getServerEnv() memoizes on first call, and APP_URL defaults to this in test env (APP_ENV defaults
// to "test", not "production", so PRSprint 14A's localhost guard doesn't apply here) — matches every
// other secret-gated route test's constraint in this codebase.
const URL = "http://localhost:3000/api/webhooks/sms/twilio/inbound";

function sign(params: Record<string, string>): string {
  let data = URL;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  return createHmac("sha1", AUTH_TOKEN).update(data, "utf8").digest("base64");
}

function buildRequest(params: Record<string, string>, options?: { skipSignature?: boolean; badSignature?: boolean }) {
  const rawBody = new URLSearchParams(params).toString();
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (!options?.skipSignature) {
    headers["x-twilio-signature"] = options?.badSignature ? "AAAAAAAAAAAAAAAAAAAAAAAAAAAA=" : sign(params);
  }
  return new NextRequest("http://localhost/api/webhooks/sms/twilio/inbound", { method: "POST", headers, body: rawBody });
}

describe("POST /api/webhooks/sms/twilio/inbound", () => {
  let notifyCtx: ReturnType<typeof createTestNotificationService>;

  beforeAll(() => {
    process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  });

  beforeEach(() => {
    notifyCtx = createTestNotificationService();
  });

  function handler() {
    return withErrorHandling("sms_inbound_webhook", createSmsInboundWebhookHandler(notifyCtx.notificationService));
  }

  it("rejects a request with an invalid signature (403)", async () => {
    const response = await handler()(buildRequest({ From: "+15551234567", Body: "STOP" }, { badSignature: true }));
    expect(response.status).toBe(403);
  });

  it("rejects a request with a missing signature header (403)", async () => {
    const response = await handler()(buildRequest({ From: "+15551234567", Body: "STOP" }, { skipSignature: true }));
    expect(response.status).toBe(403);
  });

  it("records an opt-out on a verified STOP reply", async () => {
    const response = await handler()(buildRequest({ From: "+15551234567", Body: "STOP" }));
    expect(response.status).toBe(200);
    expect(await notifyCtx.smsOptOuts.isOptedOut("+15551234567")).toBe(true);
  });

  it("recognizes other STOP-family keywords (case-insensitive)", async () => {
    await handler()(buildRequest({ From: "+15559990000", Body: "unsubscribe" }));
    expect(await notifyCtx.smsOptOuts.isOptedOut("+15559990000")).toBe(true);
  });

  it("does not record an opt-out for HELP", async () => {
    const response = await handler()(buildRequest({ From: "+15551234567", Body: "HELP" }));
    expect(response.status).toBe(200);
    expect(await notifyCtx.smsOptOuts.isOptedOut("+15551234567")).toBe(false);
  });

  it("does not record an opt-out for arbitrary free-text replies", async () => {
    const response = await handler()(buildRequest({ From: "+15551234567", Body: "thanks!" }));
    expect(response.status).toBe(200);
    expect(await notifyCtx.smsOptOuts.isOptedOut("+15551234567")).toBe(false);
  });

  it("is idempotent — a repeated STOP reply doesn't error", async () => {
    await handler()(buildRequest({ From: "+15551234567", Body: "STOP" }));
    const second = await handler()(buildRequest({ From: "+15551234567", Body: "STOP" }));
    expect(second.status).toBe(200);
    expect(await notifyCtx.smsOptOuts.isOptedOut("+15551234567")).toBe(true);
  });
});
