import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseFormUrlEncoded, verifyTwilioWebhookSignature } from "./verifyTwilioWebhookSignature";

const AUTH_TOKEN = "twilio_test_auth_token";
const URL = "https://paid2you.com/api/webhooks/sms/twilio/inbound";

function sign(url: string, params: Record<string, string>, authToken: string): string {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    data += key + params[key];
  }
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

describe("verifyTwilioWebhookSignature", () => {
  const params = { From: "+15551234567", Body: "STOP", MessageSid: "SM123" };

  it("verifies a correctly signed request", () => {
    const signature = sign(URL, params, AUTH_TOKEN);
    expect(verifyTwilioWebhookSignature(URL, params, signature, AUTH_TOKEN)).toBe(true);
  });

  it("rejects a signature computed with the wrong auth token", () => {
    const signature = sign(URL, params, "a-different-token");
    expect(verifyTwilioWebhookSignature(URL, params, signature, AUTH_TOKEN)).toBe(false);
  });

  it("rejects when a param value is tampered with after signing", () => {
    const signature = sign(URL, params, AUTH_TOKEN);
    const tampered = { ...params, Body: "START" };
    expect(verifyTwilioWebhookSignature(URL, tampered, signature, AUTH_TOKEN)).toBe(false);
  });

  it("rejects when the URL doesn't match what was signed (e.g. a different route)", () => {
    const signature = sign(URL, params, AUTH_TOKEN);
    expect(verifyTwilioWebhookSignature("https://paid2you.com/api/webhooks/sms/twilio/status", params, signature, AUTH_TOKEN)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyTwilioWebhookSignature(URL, params, null, AUTH_TOKEN)).toBe(false);
  });

  it("rejects a malformed (non-base64) signature header", () => {
    expect(verifyTwilioWebhookSignature(URL, params, "not valid base64!!!", AUTH_TOKEN)).toBe(false);
  });

  it("is insensitive to the order params were supplied in, since keys are sorted before signing", () => {
    const signature = sign(URL, params, AUTH_TOKEN);
    const reordered = { MessageSid: params.MessageSid, Body: params.Body, From: params.From };
    expect(verifyTwilioWebhookSignature(URL, reordered, signature, AUTH_TOKEN)).toBe(true);
  });
});

describe("parseFormUrlEncoded", () => {
  it("parses a standard application/x-www-form-urlencoded body", () => {
    const parsed = parseFormUrlEncoded("From=%2B15551234567&Body=STOP&MessageSid=SM123");
    expect(parsed).toEqual({ From: "+15551234567", Body: "STOP", MessageSid: "SM123" });
  });

  it("returns an empty object for an empty body", () => {
    expect(parseFormUrlEncoded("")).toEqual({});
  });
});
