import { describe, expect, it } from "vitest";
import { EmailDeliveryError } from "./emailDeliveryError";
import { ConsoleEmailSender } from "./consoleEmailSender";

describe("ConsoleEmailSender (PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION, requirement #9)", () => {
  it("logs and reports success (providerMessageId: null) by default — unchanged non-production behavior", async () => {
    const sender = new ConsoleEmailSender();
    const result = await sender.send({ to: "user@example.com", subject: "Hi", body: "Body" });
    expect(result.providerMessageId).toBeNull();
  });

  it("throws a non-retryable, 'configuration'-category EmailDeliveryError instead of silently logging when constructed with failClosed: true", async () => {
    const sender = new ConsoleEmailSender({ failClosed: true });
    await expect(sender.send({ to: "user@example.com", subject: "Hi", body: "Body" })).rejects.toThrow(EmailDeliveryError);
    try {
      await sender.send({ to: "user@example.com", subject: "Hi", body: "Body" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EmailDeliveryError);
      expect((error as EmailDeliveryError).retryable).toBe(false);
      expect((error as EmailDeliveryError).category).toBe("configuration");
    }
  });
});
