import { describe, expect, it } from "vitest";
import { SmsDeliveryError } from "./smsDeliveryError";
import { ConsoleSmsSender } from "./consoleSmsSender";

describe("ConsoleSmsSender (PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION, requirement #9)", () => {
  it("logs and reports success (providerMessageId: null) by default — unchanged non-production behavior", async () => {
    const sender = new ConsoleSmsSender();
    const result = await sender.send({ to: "+15005550006", body: "Hi" });
    expect(result.providerMessageId).toBeNull();
  });

  it("throws a non-retryable, 'configuration'-category SmsDeliveryError instead of silently logging when constructed with failClosed: true", async () => {
    const sender = new ConsoleSmsSender({ failClosed: true });
    await expect(sender.send({ to: "+15005550006", body: "Hi" })).rejects.toThrow(SmsDeliveryError);
    try {
      await sender.send({ to: "+15005550006", body: "Hi" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SmsDeliveryError);
      expect((error as SmsDeliveryError).retryable).toBe(false);
      expect((error as SmsDeliveryError).category).toBe("configuration");
    }
  });
});
