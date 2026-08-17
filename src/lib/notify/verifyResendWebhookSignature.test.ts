import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyResendWebhookSignature } from "./verifyResendWebhookSignature";

const SECRET = "whsec_" + Buffer.from("a-32-byte-test-secret-value!!!!").toString("base64");

function sign(svixId: string, svixTimestamp: string, rawBody: string, secret: string): string {
  const secretBytes = Buffer.from(secret.slice("whsec_".length), "base64");
  const signed = `${svixId}.${svixTimestamp}.${rawBody}`;
  const digest = createHmac("sha256", secretBytes).update(signed).digest("base64");
  return `v1,${digest}`;
}

describe("verifyResendWebhookSignature", () => {
  const rawBody = JSON.stringify({ type: "email.delivered", data: { email_id: "msg_1" } });

  it("verifies a correctly signed, fresh webhook", () => {
    const now = new Date();
    const svixTimestamp = String(Math.floor(now.getTime() / 1000));
    const svixSignature = sign("msg_id_1", svixTimestamp, rawBody, SECRET);
    const result = verifyResendWebhookSignature(rawBody, { svixId: "msg_id_1", svixTimestamp, svixSignature }, SECRET, now);
    expect(result).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const now = new Date();
    const svixTimestamp = String(Math.floor(now.getTime() / 1000));
    const wrongSecret = "whsec_" + Buffer.from("a-completely-different-secret!!!").toString("base64");
    const svixSignature = sign("msg_id_1", svixTimestamp, rawBody, wrongSecret);
    const result = verifyResendWebhookSignature(rawBody, { svixId: "msg_id_1", svixTimestamp, svixSignature }, SECRET, now);
    expect(result).toBe(false);
  });

  it("rejects a tampered body even with an otherwise-valid signature", () => {
    const now = new Date();
    const svixTimestamp = String(Math.floor(now.getTime() / 1000));
    const svixSignature = sign("msg_id_1", svixTimestamp, rawBody, SECRET);
    const tamperedBody = JSON.stringify({ type: "email.delivered", data: { email_id: "msg_ATTACKER_SUBSTITUTED" } });
    const result = verifyResendWebhookSignature(tamperedBody, { svixId: "msg_id_1", svixTimestamp, svixSignature }, SECRET, now);
    expect(result).toBe(false);
  });

  it("rejects a stale timestamp outside the tolerance window (replay protection)", () => {
    const now = new Date();
    const staleTimestamp = String(Math.floor(now.getTime() / 1000) - 10 * 60); // 10 minutes old
    const svixSignature = sign("msg_id_1", staleTimestamp, rawBody, SECRET);
    const result = verifyResendWebhookSignature(rawBody, { svixId: "msg_id_1", svixTimestamp: staleTimestamp, svixSignature }, SECRET, now);
    expect(result).toBe(false);
  });

  it("rejects when any required header is missing", () => {
    const now = new Date();
    const svixTimestamp = String(Math.floor(now.getTime() / 1000));
    const svixSignature = sign("msg_id_1", svixTimestamp, rawBody, SECRET);
    expect(verifyResendWebhookSignature(rawBody, { svixId: null, svixTimestamp, svixSignature }, SECRET, now)).toBe(false);
    expect(verifyResendWebhookSignature(rawBody, { svixId: "msg_id_1", svixTimestamp: null, svixSignature }, SECRET, now)).toBe(false);
    expect(verifyResendWebhookSignature(rawBody, { svixId: "msg_id_1", svixTimestamp, svixSignature: null }, SECRET, now)).toBe(false);
  });

  it("accepts a match among multiple space-separated signatures (key rotation)", () => {
    const now = new Date();
    const svixTimestamp = String(Math.floor(now.getTime() / 1000));
    const oldSecret = "whsec_" + Buffer.from("an-old-rotated-out-secret!!!!!!!").toString("base64");
    const validSig = sign("msg_id_1", svixTimestamp, rawBody, SECRET);
    const staleSig = sign("msg_id_1", svixTimestamp, rawBody, oldSecret);
    const combined = `${staleSig} ${validSig}`;
    const result = verifyResendWebhookSignature(rawBody, { svixId: "msg_id_1", svixTimestamp, svixSignature: combined }, SECRET, now);
    expect(result).toBe(true);
  });
});
