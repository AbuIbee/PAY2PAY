import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailDeliveryError } from "./emailDeliveryError";
import { ResendEmailSender } from "./resendEmailSender";

const CONFIG = { apiKey: "re_test_key", fromAddress: "notifications@paid2you.com", fromName: "PAY2PAY" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("ResendEmailSender", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("sends via the Resend API and returns the provider message id on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: "msg_abc123" }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const sender = new ResendEmailSender(CONFIG);
    const result = await sender.send({ to: "user@example.com", subject: "Hello", body: "Body text", ctaUrl: "https://app.test/agreements/detail?id=1", ctaText: "Review" });

    expect(result).toEqual({ providerMessageId: "msg_abc123" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_test_key");
    const body = JSON.parse(init.body as string);
    expect(body.from).toBe("PAY2PAY <notifications@paid2you.com>");
    expect(body.to).toEqual(["user@example.com"]);
    expect(body.subject).toBe("Hello");
    expect(body.html).toContain("Body text");
    expect(body.html).toContain("https://app.test/agreements/detail?id=1");
    expect(body.text).toContain("Body text");
    // The API key must never appear anywhere in the outbound request body.
    expect(init.body as string).not.toContain(CONFIG.apiKey);
  });

  it("returns a null providerMessageId when the provider response has no id", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(200, {})) as unknown as typeof fetch;
    const sender = new ResendEmailSender(CONFIG);
    const result = await sender.send({ to: "user@example.com", subject: "Hello", body: "Body" });
    expect(result).toEqual({ providerMessageId: null });
  });

  it("classifies a 429 as retryable/rate_limited", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(429, { message: "rate limited" })) as unknown as typeof fetch;
    const sender = new ResendEmailSender(CONFIG);
    await expect(sender.send({ to: "user@example.com", subject: "s", body: "b" })).rejects.toMatchObject({
      retryable: true,
      category: "rate_limited",
    });
  });

  it("classifies a 500 as retryable/provider_error", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(500, { message: "internal" })) as unknown as typeof fetch;
    const sender = new ResendEmailSender(CONFIG);
    await expect(sender.send({ to: "user@example.com", subject: "s", body: "b" })).rejects.toMatchObject({
      retryable: true,
      category: "provider_error",
    });
  });

  it("classifies a 401 as non-retryable/configuration", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(401, { message: "unauthorized" })) as unknown as typeof fetch;
    const sender = new ResendEmailSender(CONFIG);
    await expect(sender.send({ to: "user@example.com", subject: "s", body: "b" })).rejects.toMatchObject({
      retryable: false,
      category: "configuration",
    });
  });

  it("classifies a 400 as non-retryable/invalid_recipient", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(400, { message: "invalid `to` field" })) as unknown as typeof fetch;
    const sender = new ResendEmailSender(CONFIG);
    await expect(sender.send({ to: "not-an-email", subject: "s", body: "b" })).rejects.toMatchObject({
      retryable: false,
      category: "invalid_recipient",
    });
  });

  it("classifies a network failure (fetch throws) as retryable/timeout", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNRESET")) as unknown as typeof fetch;
    const sender = new ResendEmailSender(CONFIG);
    await expect(sender.send({ to: "user@example.com", subject: "s", body: "b" })).rejects.toBeInstanceOf(EmailDeliveryError);
    await expect(new ResendEmailSender(CONFIG).send({ to: "user@example.com", subject: "s", body: "b" })).rejects.toMatchObject({
      retryable: true,
      category: "timeout",
    });
  });

  it("every thrown failure is an EmailDeliveryError instance", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(422, { message: "unprocessable" })) as unknown as typeof fetch;
    const sender = new ResendEmailSender(CONFIG);
    await expect(sender.send({ to: "user@example.com", subject: "s", body: "b" })).rejects.toBeInstanceOf(EmailDeliveryError);
  });
});
