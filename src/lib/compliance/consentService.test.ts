import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/errors";
import { createTestConsentService } from "./testFakes";

describe("ConsentService", () => {
  it("records a versioned consent event with actor, time, and method", async () => {
    const { consentService } = createTestConsentService();
    const userId = randomUUID();

    const record = await consentService.recordConsent({
      userId,
      policyType: "terms_of_service",
      policyVersion: "2026-08-19",
      method: "signup_checkbox",
      ipAddress: "203.0.113.1",
    });

    expect(record.policyType).toBe("terms_of_service");
    expect(record.policyVersion).toBe("2026-08-19");
    expect(record.method).toBe("signup_checkbox");
    expect(record.userId).toBe(userId);
    expect(record.consentedAt).toBeInstanceOf(Date);
  });

  it("rejects an empty policy version or capture method", async () => {
    const { consentService } = createTestConsentService();
    const userId = randomUUID();

    await expect(
      consentService.recordConsent({ userId, policyType: "sms_consent", policyVersion: "", method: "signup_checkbox", ipAddress: null }),
    ).rejects.toThrow(ValidationError);
    await expect(
      consentService.recordConsent({ userId, policyType: "sms_consent", policyVersion: "v1", method: "", ipAddress: null }),
    ).rejects.toThrow(ValidationError);
  });

  it("lists a user's own consent history, newest first, never another user's", async () => {
    const { consentService } = createTestConsentService();
    const userId = randomUUID();
    const otherUserId = randomUUID();

    await consentService.recordConsent({ userId, policyType: "terms_of_service", policyVersion: "v1", method: "signup_checkbox", ipAddress: null });
    await consentService.recordConsent({ userId, policyType: "privacy_policy", policyVersion: "v1", method: "signup_checkbox", ipAddress: null });
    await consentService.recordConsent({ userId: otherUserId, policyType: "terms_of_service", policyVersion: "v1", method: "signup_checkbox", ipAddress: null });

    const history = await consentService.listConsentsForUser(userId);
    expect(history).toHaveLength(2);
    expect(history.every((c) => c.userId === userId)).toBe(true);
  });
});
