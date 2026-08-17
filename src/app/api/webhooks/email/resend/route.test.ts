import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { createTestNotificationService } from "@/lib/notify/testFakes";
import { createEmailWebhookHandler } from "./route";

const SECRET = "whsec_" + Buffer.from("a-32-byte-test-secret-value!!!!").toString("base64");

function sign(svixId: string, svixTimestamp: string, rawBody: string): string {
  const secretBytes = Buffer.from(SECRET.slice("whsec_".length), "base64");
  const digest = createHmac("sha256", secretBytes).update(`${svixId}.${svixTimestamp}.${rawBody}`).digest("base64");
  return `v1,${digest}`;
}

function buildRequest(payload: unknown, options?: { skipSignature?: boolean; badSignature?: boolean }) {
  const rawBody = JSON.stringify(payload);
  const svixId = "msg_evt_1";
  const svixTimestamp = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!options?.skipSignature) {
    headers["svix-id"] = svixId;
    headers["svix-timestamp"] = svixTimestamp;
    headers["svix-signature"] = options?.badSignature ? "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" : sign(svixId, svixTimestamp, rawBody);
  }
  return new NextRequest("http://localhost/api/webhooks/email/resend", { method: "POST", headers, body: rawBody });
}

describe("POST /api/webhooks/email/resend", () => {
  let notifyCtx: ReturnType<typeof createTestNotificationService>;

  beforeAll(() => {
    // getServerEnv() memoizes on first call — set this once, before any handler invocation, matching
    // every other secret-gated route test's constraint in this codebase (e.g.
    // scheduler/expire-relationship-invitations/route.test.ts's identical CRON_SECRET precedent).
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
  });

  beforeEach(() => {
    notifyCtx = createTestNotificationService();
  });

  function handler() {
    return withErrorHandling("email_webhook", createEmailWebhookHandler(notifyCtx.notificationService));
  }

  it("rejects a request with an invalid signature (403)", async () => {
    const response = await handler()(buildRequest({ type: "email.delivered", data: { email_id: "msg_1" } }, { badSignature: true }));
    expect(response.status).toBe(403);
  });

  it("rejects a request with missing signature headers (403)", async () => {
    const response = await handler()(buildRequest({ type: "email.delivered", data: { email_id: "msg_1" } }, { skipSignature: true }));
    expect(response.status).toBe(403);
  });

  it("acknowledges (200) and ignores an event type it doesn't track", async () => {
    const response = await handler()(buildRequest({ type: "email.opened", data: { email_id: "msg_1" } }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ignored");
  });

  it("updates the matching notification_event to delivered on a verified email.delivered event", async () => {
    notifyCtx.contacts.set("user-1", "user1@example.com");
    notifyCtx.emailSender.setNextProviderMessageId("msg_1");
    const [record] = await notifyCtx.notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: {} });
    if (!record) throw new Error("expected a record");
    expect((await notifyCtx.events.findById(record.id))?.status).toBe("sent");

    const response = await handler()(buildRequest({ type: "email.delivered", data: { email_id: "msg_1" } }));
    expect(response.status).toBe(200);
    expect((await notifyCtx.events.findById(record.id))?.status).toBe("delivered");
  });

  it("marks the matching notification_event permanently failed on a verified email.bounced event", async () => {
    notifyCtx.contacts.set("user-1", "user1@example.com");
    notifyCtx.emailSender.setNextProviderMessageId("msg_bounced");
    const [record] = await notifyCtx.notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: {} });
    if (!record) throw new Error("expected a record");

    const response = await handler()(buildRequest({ type: "email.bounced", data: { email_id: "msg_bounced" } }));
    expect(response.status).toBe(200);
    const updated = await notifyCtx.events.findById(record.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.nextRetryAt).toBeNull();
  });

  it("acknowledges (200) a verified event referencing an unknown provider message id, without throwing", async () => {
    const response = await handler()(buildRequest({ type: "email.delivered", data: { email_id: "no-such-message" } }));
    expect(response.status).toBe(200);
  });

  it("rejects malformed JSON even with a valid-looking signature computed over it (400)", async () => {
    const rawBody = "{not valid json";
    const svixId = "msg_evt_2";
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const request = new NextRequest("http://localhost/api/webhooks/email/resend", {
      method: "POST",
      headers: { "svix-id": svixId, "svix-timestamp": svixTimestamp, "svix-signature": sign(svixId, svixTimestamp, rawBody) },
      body: rawBody,
    });
    const response = await handler()(request);
    expect(response.status).toBe(400);
  });
});
