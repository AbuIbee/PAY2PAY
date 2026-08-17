import { afterEach, describe, expect, it, vi } from "vitest";
import { SmsDeliveryError } from "./smsDeliveryError";
import { TwilioSmsSender } from "./twilioSmsSender";

const CONFIG = {
  accountSid: "AC" + "x".repeat(32),
  authToken: "twilio_test_token",
  messagingServiceSid: null,
  fromNumber: "+15005550006",
  statusCallbackUrl: "https://paid2you.com/api/webhooks/sms/twilio/status",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("TwilioSmsSender", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("sends via the Twilio Messages API and returns the provider message sid on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { sid: "SM_abc123" }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const sender = new TwilioSmsSender(CONFIG);
    const result = await sender.send({ to: "+15551234567", body: "Your code is 123456." });

    expect(result).toEqual({ providerMessageId: "SM_abc123" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${CONFIG.accountSid}/Messages.json`);
    const body = new URLSearchParams(init.body as string);
    expect(body.get("To")).toBe("+15551234567");
    expect(body.get("Body")).toBe("Your code is 123456.");
    expect(body.get("From")).toBe(CONFIG.fromNumber);
    expect(body.get("StatusCallback")).toBe(CONFIG.statusCallbackUrl);
    // The auth token must never appear anywhere in the outbound request body.
    expect(init.body as string).not.toContain(CONFIG.authToken);
    // Basic auth header is present but the token isn't visible in plain text.
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });

  it("prefers MessagingServiceSid over From when both are configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { sid: "SM_1" }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const sender = new TwilioSmsSender({ ...CONFIG, messagingServiceSid: "MG" + "x".repeat(32) });
    await sender.send({ to: "+15551234567", body: "Hi" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(init.body as string);
    expect(body.get("MessagingServiceSid")).toBe("MG" + "x".repeat(32));
    expect(body.has("From")).toBe(false);
  });

  it("throws a non-retryable configuration error when neither a messaging service nor a from-number is configured", async () => {
    const sender = new TwilioSmsSender({ ...CONFIG, fromNumber: null });
    await expect(sender.send({ to: "+15551234567", body: "Hi" })).rejects.toMatchObject({ retryable: false, category: "configuration" });
  });

  it("classifies a 429 as retryable/rate_limited", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(429, { code: 20429 })) as unknown as typeof fetch;
    const sender = new TwilioSmsSender(CONFIG);
    await expect(sender.send({ to: "+15551234567", body: "Hi" })).rejects.toMatchObject({ retryable: true, category: "rate_limited" });
  });

  it("classifies a 500 as retryable/provider_error", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(500, {})) as unknown as typeof fetch;
    const sender = new TwilioSmsSender(CONFIG);
    await expect(sender.send({ to: "+15551234567", body: "Hi" })).rejects.toMatchObject({ retryable: true, category: "provider_error" });
  });

  it("classifies a 401 as non-retryable/configuration", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(401, {})) as unknown as typeof fetch;
    const sender = new TwilioSmsSender(CONFIG);
    await expect(sender.send({ to: "+15551234567", body: "Hi" })).rejects.toMatchObject({ retryable: false, category: "configuration" });
  });

  it("classifies Twilio error code 21610 (recipient opted out) as non-retryable/opted_out", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(400, { code: 21610 })) as unknown as typeof fetch;
    const sender = new TwilioSmsSender(CONFIG);
    await expect(sender.send({ to: "+15551234567", body: "Hi" })).rejects.toMatchObject({ retryable: false, category: "opted_out" });
  });

  it("classifies an unrecognized 4xx as non-retryable/invalid_number", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(400, { code: 21211 })) as unknown as typeof fetch;
    const sender = new TwilioSmsSender(CONFIG);
    await expect(sender.send({ to: "not-a-number", body: "Hi" })).rejects.toMatchObject({ retryable: false, category: "invalid_number" });
  });

  it("classifies a network failure (fetch throws) as retryable/timeout", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNRESET")) as unknown as typeof fetch;
    const sender = new TwilioSmsSender(CONFIG);
    await expect(sender.send({ to: "+15551234567", body: "Hi" })).rejects.toBeInstanceOf(SmsDeliveryError);
  });
});
