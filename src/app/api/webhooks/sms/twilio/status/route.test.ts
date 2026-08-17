import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { createTestNotificationService } from "@/lib/notify/testFakes";
import { createSmsStatusWebhookHandler } from "./route";

const AUTH_TOKEN = "twilio_test_auth_token_0123456789";
const URL = "http://localhost:3000/api/webhooks/sms/twilio/status";

function sign(params: Record<string, string>): string {
  let data = URL;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  return createHmac("sha1", AUTH_TOKEN).update(data, "utf8").digest("base64");
}

function buildRequest(params: Record<string, string>, options?: { badSignature?: boolean }) {
  const rawBody = new URLSearchParams(params).toString();
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    "x-twilio-signature": options?.badSignature ? "AAAAAAAAAAAAAAAAAAAAAAAAAAAA=" : sign(params),
  };
  return new NextRequest("http://localhost/api/webhooks/sms/twilio/status", { method: "POST", headers, body: rawBody });
}

describe("POST /api/webhooks/sms/twilio/status", () => {
  let notifyCtx: ReturnType<typeof createTestNotificationService>;

  beforeAll(() => {
    process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  });

  beforeEach(() => {
    notifyCtx = createTestNotificationService();
  });

  function handler() {
    return withErrorHandling("sms_status_webhook", createSmsStatusWebhookHandler(notifyCtx.notificationService));
  }

  it("rejects a request with an invalid signature (403)", async () => {
    const response = await handler()(buildRequest({ MessageSid: "SM1", MessageStatus: "delivered" }, { badSignature: true }));
    expect(response.status).toBe(403);
  });

  it("acknowledges (200) and ignores a non-terminal status like 'sent' or 'queued'", async () => {
    const response = await handler()(buildRequest({ MessageSid: "SM1", MessageStatus: "sent" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ignored");
  });

  it("updates the matching notification_event to delivered on a verified 'delivered' callback", async () => {
    notifyCtx.contacts.setPhone("user-1", "+15551234567");
    notifyCtx.smsSender.setNextProviderMessageId("SM_1");
    const records = await notifyCtx.notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_failed", payload: {} });
    const record = records.find((r) => r.channel === "sms")!;
    expect((await notifyCtx.events.findById(record.id))?.status).toBe("sent");

    const response = await handler()(buildRequest({ MessageSid: "SM_1", MessageStatus: "delivered" }));
    expect(response.status).toBe(200);
    expect((await notifyCtx.events.findById(record.id))?.status).toBe("delivered");
  });

  it("marks the matching notification_event permanently failed on a verified 'undelivered' callback", async () => {
    notifyCtx.contacts.setPhone("user-1", "+15551234567");
    notifyCtx.smsSender.setNextProviderMessageId("SM_undelivered");
    const records = await notifyCtx.notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_failed", payload: {} });
    const record = records.find((r) => r.channel === "sms")!;

    const response = await handler()(buildRequest({ MessageSid: "SM_undelivered", MessageStatus: "undelivered", ErrorCode: "30003" }));
    expect(response.status).toBe(200);
    const updated = await notifyCtx.events.findById(record.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.nextRetryAt).toBeNull();
  });

  it("acknowledges (200) a verified callback referencing an unknown provider message id, without throwing", async () => {
    const response = await handler()(buildRequest({ MessageSid: "no-such-message", MessageStatus: "delivered" }));
    expect(response.status).toBe(200);
  });
});
