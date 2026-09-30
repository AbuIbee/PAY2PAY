import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * REM-015 — completes production email/SMS fail-closed test coverage. `getEmailSender.test.ts` /
 * `getSmsSender.test.ts` already prove the factory selects a `failClosed: true` `ConsoleEmailSender`/
 * `ConsoleSmsSender` in production without live credentials, and `consoleEmailSender.test.ts` /
 * `consoleSmsSender.test.ts` prove that sender then throws instead of logging.
 * `notificationService.test.ts`'s own "non-retryable EmailDeliveryError dead-letters immediately" test
 * proves the GENERAL mechanism using a generic in-memory test double's simulated failure — it never
 * exercises the REAL production factory output at all.
 *
 * This file closes that gap: it wires the REAL `getEmailSender()`/`getSmsSender()` (not a test double)
 * into a `NotificationService`, with every other dependency an in-memory fake (mirrors
 * `createTestNotificationService`'s own composition), under `APP_ENV=production` with no live
 * credentials configured — and proves the notification is dead-lettered on the first attempt (never
 * retried, since "configuration" is non-retryable), through the ENTIRE real chain: factory -> sender ->
 * NotificationService's error classification -> durable event row.
 *
 * MASTER CONTROL ORDER STAGE-01-FINAL (SV-011 / SV-012) additions, on top of the original eleven tests:
 *
 * SV-011 — complete environment isolation + unconditional default-deny network transport. The
 * environment-variable list below (`NOTIFY_ENV_KEYS`) is built directly from the actual production
 * decision points this file exercises: `getEmailSender.ts` (RESEND_API_KEY, EMAIL_FROM_ADDRESS,
 * EMAIL_FROM_NAME, EMAIL_DELIVERY_ENABLED, APP_ENV), `getSmsSender.ts` (TWILIO_ACCOUNT_SID,
 * TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID, TWILIO_FROM_NUMBER, SMS_DELIVERY_ENABLED, APP_ENV),
 * and `resendEmailSender.ts`/`twilioSmsSender.ts`'s own reachable `APP_URL` dependency (via
 * `getSmsSender.ts`'s `statusCallbackUrl`, and `getServerEnv()`'s own `APP_URL`/`RESEND_API_KEY`
 * cross-field validation). Every one of these keys is unconditionally cleared before each test — not
 * just the ones a given test happens to pass — and every test also installs a default-deny `fetch`
 * mock BEFORE the test body runs, so a real network call is structurally impossible even if a future
 * regression in the sender-selection logic (`getEmailSender`/`getSmsSender`) were to accidentally select
 * a live sender when it shouldn't. Only a test that explicitly wants to exercise configured transport
 * behavior replaces that default-deny mock with its own controlled one (unchanged from the original
 * eight configured-transport tests' own pattern).
 *
 * SV-012 — deferred-transport ordering. The original "STEP 5"/"STEP 6" success tests only ever observed
 * the FINAL state after an immediately-resolving mocked transport — they never actually proved the
 * notification stays unsent while the provider's acceptance is still unresolved. The four new
 * "ordering" tests below use an explicit, test-controlled deferred promise as the mocked transport's
 * return value, inspect the real in-memory repository's actual row WHILE that promise is still pending,
 * and only then resolve/reject it — proving the real NotificationService/sender chain never marks an
 * event sent before the provider has actually confirmed acceptance.
 */
describe("REM-015 — production email/SMS fail-closed, proven end-to-end through the real factory (not a test double)", () => {
  /** SV-011: every environment key any code path reachable from this file's tests actually consults — enumerated from the real `getEmailSender.ts`/`getSmsSender.ts`/`resendEmailSender.ts`/`twilioSmsSender.ts`/`env.ts` sources, never invented. Unconditionally cleared before EVERY test, regardless of what that specific test configures. */
  const NOTIFY_ENV_KEYS = [
    "APP_ENV",
    "APP_URL",
    "RESEND_API_KEY",
    "EMAIL_FROM_ADDRESS",
    "EMAIL_FROM_NAME",
    "EMAIL_DELIVERY_ENABLED",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_MESSAGING_SERVICE_SID",
    "TWILIO_FROM_NUMBER",
    "SMS_DELIVERY_ENABLED",
  ] as const;

  /** Required only so `getServerEnv()` itself does not throw on unrelated required fields — never a notification-delivery decision point. Always set to the same fixed, non-secret test values, and always restored afterward like every other managed key. */
  const BASELINE_REQUIRED_ENV: Record<string, string> = {
    DATABASE_URL: "postgres://test:test@localhost:5432/pay2pay_test",
    AUDIT_HASH_SECRET: "test-only-audit-hash-secret-value",
    AUTH_PASSWORD_PEPPER: "test-only-auth-password-pepper-value",
  };

  const ALL_MANAGED_ENV_KEYS: string[] = [...NOTIFY_ENV_KEYS, ...Object.keys(BASELINE_REQUIRED_ENV)];

  /** Distinguishes "was absent" (restore by deleting) from "was present, even as an empty string" (restore the exact value) — never restores an absent variable as the literal string "undefined". */
  let savedEnv: Record<string, string | undefined> = {};

  /** Unconditionally deletes every notify-relevant key, then sets only the fixed baseline. Exposed (not just inlined in beforeEach) so the poisoned-environment test below can re-exercise this exact mechanism itself, independent of test ordering. */
  function establishCleanNotifyBaseline(): void {
    for (const key of NOTIFY_ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(BASELINE_REQUIRED_ENV)) process.env[key] = value;
  }

  function setEnv(overrides: Record<string, string | undefined>): void {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  /** SV-011: the unconditional default-deny transport. Every test starts with this installed; a test
   * exercising real configured transport behavior replaces it via its own `vi.stubGlobal("fetch", ...)`. */
  let denyFetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ALL_MANAGED_ENV_KEYS) savedEnv[key] = process.env[key];
    establishCleanNotifyBaseline();
    vi.resetModules();
    denyFetchSpy = vi.fn(async () => {
      throw new Error(
        "TEST-ONLY DEFAULT-DENY TRANSPORT (SV-011): no notification test may reach a real network call unless it explicitly installs its own controlled transport mock first.",
      );
    });
    vi.stubGlobal("fetch", denyFetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of ALL_MANAGED_ENV_KEYS) {
      const prior = savedEnv[key];
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
    vi.resetModules();
  });

  async function buildRealNotificationService() {
    const { getEmailSender } = await import("./getEmailSender");
    const { getSmsSender } = await import("./getSmsSender");
    const { NotificationService } = await import("./notificationService");
    const { InMemoryNotificationEventRepository, InMemoryNotificationPreferenceRepository, InMemoryUserContactReader, InMemorySmsOptOutRepository, InMemorySmsConsentRepository } =
      await import("./testFakes");

    const events = new InMemoryNotificationEventRepository();
    const contacts = new InMemoryUserContactReader();
    contacts.set("user-1", "user1@example.com");
    contacts.setPhone("user-1", "+15005550006");
    const smsConsents = new InMemorySmsConsentRepository(true, contacts);
    const notificationService = new NotificationService({
      events,
      preferences: new InMemoryNotificationPreferenceRepository(),
      emailSender: getEmailSender(),
      smsSender: getSmsSender(),
      contacts,
      smsOptOuts: new InMemorySmsOptOutRepository(),
      smsConsents,
      appUrl: "https://paid2you.com",
    });
    return { notificationService, events };
  }

  /** A deferred promise the test itself controls the settlement timing of — never an arbitrary sleep. */
  function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("production, no live Resend/Twilio credentials: both the email and SMS channel dead-letter immediately on the first attempt — never silently 'sent', never retried as if transient", async () => {
    setEnv({ APP_ENV: "production", APP_URL: "https://paid2you.com" });
    const { notificationService, events } = await buildRealNotificationService();

    // payment_failed's default channels include both email and sms (plus in_app, which never fails).
    const records = await notificationService.notify({
      recipientUserId: "user-1",
      notificationType: "payment_failed",
      payload: { displayAmount: "$50.00" },
    });

    const emailRecord = records.find((r) => r.channel === "email")!;
    const smsRecord = records.find((r) => r.channel === "sms")!;
    expect(emailRecord).toBeDefined();
    expect(smsRecord).toBeDefined();

    const updatedEmail = await events.findById(emailRecord.id);
    const updatedSms = await events.findById(smsRecord.id);
    expect(updatedEmail?.status).toBe("failed");
    expect(updatedEmail?.attemptCount).toBe(1);
    expect(updatedEmail?.nextRetryAt).toBeNull(); // dead-lettered, not scheduled for retry — a misconfiguration is not "try again later."
    expect(updatedSms?.status).toBe("failed");
    expect(updatedSms?.attemptCount).toBe(1);
    expect(updatedSms?.nextRetryAt).toBeNull();
    expect(denyFetchSpy).not.toHaveBeenCalled();
  });

  it("development (unchanged, safe default): the SAME real wiring succeeds via console-only logging — proves the production gate is genuinely APP_ENV-scoped, not a global regression", async () => {
    setEnv({ APP_ENV: "development" });
    const { notificationService, events } = await buildRealNotificationService();

    const records = await notificationService.notify({
      recipientUserId: "user-1",
      notificationType: "payment_failed",
      payload: { displayAmount: "$50.00" },
    });

    const emailRecord = records.find((r) => r.channel === "email")!;
    const smsRecord = records.find((r) => r.channel === "sms")!;
    expect((await events.findById(emailRecord.id))?.status).toBe("sent");
    expect((await events.findById(smsRecord.id))?.status).toBe("sent");
    expect(denyFetchSpy).not.toHaveBeenCalled();
  });

  it("production WITH fully-configured live credentials: the same real wiring does not fail closed — real delivery remains possible once actually configured", async () => {
    setEnv({
      APP_ENV: "production",
      APP_URL: "https://paid2you.com",
      RESEND_API_KEY: "re_live_key",
      EMAIL_FROM_ADDRESS: "notifications@paid2you.com",
      TWILIO_ACCOUNT_SID: "AC" + "x".repeat(32),
      TWILIO_AUTH_TOKEN: "t".repeat(32),
      TWILIO_FROM_NUMBER: "+15005550006",
    });
    const { getEmailSender } = await import("./getEmailSender");
    const { getSmsSender } = await import("./getSmsSender");
    const { ResendEmailSender } = await import("./resendEmailSender");
    const { TwilioSmsSender } = await import("./twilioSmsSender");
    expect(getEmailSender()).toBeInstanceOf(ResendEmailSender);
    expect(getSmsSender()).toBeInstanceOf(TwilioSmsSender);
    expect(denyFetchSpy).not.toHaveBeenCalled();
  });

  it("REM-015 STEP 1 — production, INCOMPLETE email configuration (RESEND_API_KEY present, EMAIL_FROM_ADDRESS absent): no real transport call, no console-success fallback, never marked sent", async () => {
    setEnv({ APP_ENV: "production", APP_URL: "https://paid2you.com", RESEND_API_KEY: "re_live_key" });
    const { notificationService, events } = await buildRealNotificationService();
    const records = await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: { displayAmount: "$50.00" } });
    const emailRecord = records.find((r) => r.channel === "email")!;
    expect(denyFetchSpy).not.toHaveBeenCalled();
    const updated = await events.findById(emailRecord.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.attemptCount).toBe(1);
    expect(updated?.nextRetryAt).toBeNull(); // a misconfiguration is not "try again later" — same as the zero-credentials case.
  });

  it("REM-015 STEP 2 — production, INCOMPLETE SMS configuration (TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN present, no messaging service or from-number): no real transport call, never marked sent", async () => {
    setEnv({
      APP_ENV: "production",
      APP_URL: "https://paid2you.com",
      TWILIO_ACCOUNT_SID: "AC" + "x".repeat(32),
      TWILIO_AUTH_TOKEN: "t".repeat(32),
    });
    const { notificationService, events } = await buildRealNotificationService();
    const records = await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_failed", payload: { displayAmount: "$50.00" } });
    const smsRecord = records.find((r) => r.channel === "sms")!;
    expect(denyFetchSpy).not.toHaveBeenCalled();
    const updated = await events.findById(smsRecord.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.attemptCount).toBe(1);
    expect(updated?.nextRetryAt).toBeNull();
  });

  it("REM-015 STEP 3 — production, email delivery EXPLICITLY DISABLED (EMAIL_DELIVERY_ENABLED=false) with otherwise fully-valid credentials: no real transport call, never marked sent", async () => {
    setEnv({
      APP_ENV: "production",
      APP_URL: "https://paid2you.com",
      RESEND_API_KEY: "re_live_key",
      EMAIL_FROM_ADDRESS: "notifications@paid2you.com",
      EMAIL_DELIVERY_ENABLED: "false",
    });
    const { notificationService, events } = await buildRealNotificationService();
    const records = await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: { displayAmount: "$50.00" } });
    const emailRecord = records.find((r) => r.channel === "email")!;
    expect(denyFetchSpy).not.toHaveBeenCalled();
    expect((await events.findById(emailRecord.id))?.status).toBe("failed");
  });

  it("REM-015 STEP 4 — production, SMS delivery EXPLICITLY DISABLED (SMS_DELIVERY_ENABLED=false) with otherwise fully-valid credentials: no real transport call, never marked sent", async () => {
    setEnv({
      APP_ENV: "production",
      APP_URL: "https://paid2you.com",
      TWILIO_ACCOUNT_SID: "AC" + "x".repeat(32),
      TWILIO_AUTH_TOKEN: "t".repeat(32),
      TWILIO_FROM_NUMBER: "+15005550006",
      SMS_DELIVERY_ENABLED: "false",
    });
    const { notificationService, events } = await buildRealNotificationService();
    const records = await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_failed", payload: { displayAmount: "$50.00" } });
    const smsRecord = records.find((r) => r.channel === "sms")!;
    expect(denyFetchSpy).not.toHaveBeenCalled();
    expect((await events.findById(smsRecord.id))?.status).toBe("failed");
  });

  it("REM-015 STEP 5 — production, fully-configured email: the COMPLETE chain (real factory -> NotificationService -> mocked Resend transport -> persistence) sends exactly once and marks the event sent only after a confirmed transport success", async () => {
    setEnv({ APP_ENV: "production", APP_URL: "https://paid2you.com", RESEND_API_KEY: "re_live_key", EMAIL_FROM_ADDRESS: "notifications@paid2you.com" });
    const fetchSpy = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.resend.com/emails");
      return { ok: true, json: async () => ({ id: "resend_msg_123" }) } as Response;
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { notificationService, events } = await buildRealNotificationService();
    const records = await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: { displayAmount: "$50.00" } });
    const emailRecord = records.find((r) => r.channel === "email")!;
    expect(fetchSpy).toHaveBeenCalledTimes(1); // exactly one authorized send attempt — no actual external email (fetch is mocked).
    const updated = await events.findById(emailRecord.id);
    expect(updated?.status).toBe("sent");
    expect(updated?.providerMessageId).toBe("resend_msg_123");
  });

  it("REM-015 STEP 6 — production, fully-configured SMS: the COMPLETE chain (real factory -> NotificationService -> mocked Twilio transport -> persistence) sends exactly once and marks the event sent only after a confirmed transport success", async () => {
    setEnv({
      APP_ENV: "production",
      APP_URL: "https://paid2you.com",
      TWILIO_ACCOUNT_SID: "AC" + "x".repeat(32),
      TWILIO_AUTH_TOKEN: "t".repeat(32),
      TWILIO_FROM_NUMBER: "+15005550006",
    });
    const fetchSpy = vi.fn(async (url: string) => {
      expect(url).toContain("api.twilio.com");
      return { ok: true, json: async () => ({ sid: "twilio_msg_456" }) } as Response;
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { notificationService, events } = await buildRealNotificationService();
    const records = await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_failed", payload: { displayAmount: "$50.00" } });
    const smsRecord = records.find((r) => r.channel === "sms")!;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const updated = await events.findById(smsRecord.id);
    expect(updated?.status).toBe("sent");
    expect(updated?.providerMessageId).toBe("twilio_msg_456");
  });

  it("REM-015 STEP 7 — production, fully-configured email, the PROVIDER ITSELF rejects the send (mocked 500): no invented success — failure recorded accurately, retryable per the existing error classification", async () => {
    setEnv({ APP_ENV: "production", APP_URL: "https://paid2you.com", RESEND_API_KEY: "re_live_key", EMAIL_FROM_ADDRESS: "notifications@paid2you.com" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ message: "internal error" }) }) as unknown as Response),
    );
    const { notificationService, events } = await buildRealNotificationService();
    const records = await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: { displayAmount: "$50.00" } });
    const emailRecord = records.find((r) => r.channel === "email")!;
    const updated = await events.findById(emailRecord.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.providerMessageId).toBeNull();
    // A 500 is classified `retryable: true` (provider_error) by ResendEmailSender — the existing,
    // documented classification — so a retry IS scheduled here, unlike the permanent-configuration
    // failures above.
    expect(updated?.nextRetryAt).not.toBeNull();
  });

  it("REM-015 STEP 8 — production, fully-configured SMS, the PROVIDER ITSELF rejects the send (mocked 500): no invented success — failure recorded accurately, retryable per the existing error classification", async () => {
    setEnv({
      APP_ENV: "production",
      APP_URL: "https://paid2you.com",
      TWILIO_ACCOUNT_SID: "AC" + "x".repeat(32),
      TWILIO_AUTH_TOKEN: "t".repeat(32),
      TWILIO_FROM_NUMBER: "+15005550006",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ code: null }) }) as unknown as Response),
    );
    const { notificationService, events } = await buildRealNotificationService();
    const records = await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_failed", payload: { displayAmount: "$50.00" } });
    const smsRecord = records.find((r) => r.channel === "sms")!;
    const updated = await events.findById(smsRecord.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.providerMessageId).toBeNull();
    expect(updated?.nextRetryAt).not.toBeNull();
  });

  it("SV-011 poisoned-environment verification (N-24) — inherited, syntactically-valid-looking live credentials and delivery switches cannot survive this file's OWN baseline-establishment mechanism, so a subsequent incomplete-configuration scenario still fails closed", async () => {
    // Simulate hostile PRIOR process state — every notify-relevant variable populated with a dummy but
    // syntactically valid value, exactly as a leftover from a differently-ordered or external process
    // might leave behind — deliberately written directly to process.env, bypassing this file's own
    // `setEnv`/`establishCleanNotifyBaseline` so it does not get folded into `savedEnv`'s restoration
    // snapshot (that snapshot must still reflect the REAL pre-suite state for afterEach to restore).
    process.env.RESEND_API_KEY = "re_leftover_dummy_key";
    process.env.EMAIL_FROM_ADDRESS = "leftover@example.com";
    process.env.EMAIL_DELIVERY_ENABLED = "true";
    process.env.TWILIO_ACCOUNT_SID = "AC" + "y".repeat(32);
    process.env.TWILIO_AUTH_TOKEN = "z".repeat(32);
    process.env.TWILIO_FROM_NUMBER = "+15005550099";
    process.env.SMS_DELIVERY_ENABLED = "true";
    process.env.APP_ENV = "production";
    process.env.APP_URL = "https://leftover.example.com";

    // Re-exercise this suite's OWN isolation mechanism — proving the mechanism itself (not merely this
    // file's real beforeEach having already run once before the poisoning above) purges hostile state.
    establishCleanNotifyBaseline();
    vi.resetModules();

    // Request only RESEND_API_KEY (an intentionally incomplete email configuration). If any poisoned
    // value had survived — EMAIL_FROM_ADDRESS in particular — this send would succeed instead of
    // failing closed.
    setEnv({ APP_ENV: "production", APP_URL: "https://paid2you.com", RESEND_API_KEY: "re_live_key" });
    const { notificationService, events } = await buildRealNotificationService();
    const records = await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: { displayAmount: "$50.00" } });
    const emailRecord = records.find((r) => r.channel === "email")!;
    expect(denyFetchSpy).not.toHaveBeenCalled();
    const updated = await events.findById(emailRecord.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.nextRetryAt).toBeNull();
  });

  describe("SV-012 — transport-order verification: the event must never read as sent while provider acceptance is still unresolved", () => {
    it("N-14 / N-15 — email: unsent while the deferred transport is pending, sent only after it resolves with a confirmed success", async () => {
      setEnv({ APP_ENV: "production", APP_URL: "https://paid2you.com", RESEND_API_KEY: "re_live_key", EMAIL_FROM_ADDRESS: "notifications@paid2you.com" });
      const deferred = createDeferred<{ ok: boolean; status?: number; json: () => Promise<unknown> }>();
      const fetchSpy = vi.fn(async (url: string) => {
        expect(url).toBe("https://api.resend.com/emails");
        return deferred.promise as unknown as Response;
      });
      vi.stubGlobal("fetch", fetchSpy);
      const { notificationService, events } = await buildRealNotificationService();

      const notifyPromise = notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: { displayAmount: "$50.00" } });

      // Wait only until the transport has actually been invoked — never an arbitrary sleep.
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

      // `records` (the array `notify()` eventually returns) is not available yet — the whole call is
      // still suspended awaiting the deferred transport — so the in-memory repository's own map is
      // inspected directly, exactly as it exists right now, mid-flight.
      const preResolution = [...events.byId.values()].find((r) => r.channel === "email");
      expect(preResolution).toBeDefined();
      expect(preResolution?.status).not.toBe("sent");
      expect(preResolution?.providerMessageId).toBeNull();

      deferred.resolve({ ok: true, json: async () => ({ id: "resend_msg_deferred_1" }) });
      const records = await notifyPromise;

      const emailRecord = records.find((r) => r.channel === "email")!;
      const updated = await events.findById(emailRecord.id);
      expect(updated?.status).toBe("sent");
      expect(updated?.providerMessageId).toBe("resend_msg_deferred_1");
      expect(fetchSpy).toHaveBeenCalledTimes(1); // exactly one transport attempt, never a hidden second one.
      expect(updated?.attemptCount).toBe(0); // markSent never touches attemptCount — no retry was ever scheduled for a success.
      expect(updated?.nextRetryAt).toBeNull();
    });

    it("N-16 — email: unsent while the deferred transport is pending, remains unsent (dead-lettered, not fabricated as sent) after it resolves with a provider-level rejection", async () => {
      setEnv({ APP_ENV: "production", APP_URL: "https://paid2you.com", RESEND_API_KEY: "re_live_key", EMAIL_FROM_ADDRESS: "notifications@paid2you.com" });
      const deferred = createDeferred<{ ok: boolean; status: number; json: () => Promise<unknown> }>();
      const fetchSpy = vi.fn(async (url: string) => {
        expect(url).toBe("https://api.resend.com/emails");
        return deferred.promise as unknown as Response;
      });
      vi.stubGlobal("fetch", fetchSpy);
      const { notificationService, events } = await buildRealNotificationService();

      const notifyPromise = notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: { displayAmount: "$50.00" } });
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

      const preResolution = [...events.byId.values()].find((r) => r.channel === "email");
      expect(preResolution?.status).not.toBe("sent");
      expect(preResolution?.providerMessageId).toBeNull();

      deferred.resolve({ ok: false, status: 500, json: async () => ({ message: "internal error" }) });
      const records = await notifyPromise;

      const emailRecord = records.find((r) => r.channel === "email")!;
      const updated = await events.findById(emailRecord.id);
      expect(updated?.status).toBe("failed");
      expect(updated?.providerMessageId).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(1); // no hidden second transport request.
      expect(updated?.attemptCount).toBe(1);
      expect(updated?.nextRetryAt).not.toBeNull(); // a 500 is retryable per ResendEmailSender's existing classification.
    });

    it("N-17 / N-18 — SMS: unsent while the deferred transport is pending, sent only after it resolves with a confirmed success", async () => {
      setEnv({
        APP_ENV: "production",
        APP_URL: "https://paid2you.com",
        TWILIO_ACCOUNT_SID: "AC" + "x".repeat(32),
        TWILIO_AUTH_TOKEN: "t".repeat(32),
        TWILIO_FROM_NUMBER: "+15005550006",
      });
      const deferred = createDeferred<{ ok: boolean; status?: number; json: () => Promise<unknown> }>();
      const fetchSpy = vi.fn(async (url: string) => {
        expect(url).toContain("api.twilio.com");
        return deferred.promise as unknown as Response;
      });
      vi.stubGlobal("fetch", fetchSpy);
      const { notificationService, events } = await buildRealNotificationService();

      const notifyPromise = notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_failed", payload: { displayAmount: "$50.00" } });
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

      const preResolution = [...events.byId.values()].find((r) => r.channel === "sms");
      expect(preResolution).toBeDefined();
      expect(preResolution?.status).not.toBe("sent");
      expect(preResolution?.providerMessageId).toBeNull();

      deferred.resolve({ ok: true, json: async () => ({ sid: "twilio_msg_deferred_1" }) });
      const records = await notifyPromise;

      const smsRecord = records.find((r) => r.channel === "sms")!;
      const updated = await events.findById(smsRecord.id);
      expect(updated?.status).toBe("sent");
      expect(updated?.providerMessageId).toBe("twilio_msg_deferred_1");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(updated?.attemptCount).toBe(0);
      expect(updated?.nextRetryAt).toBeNull();
    });

    it("N-19 — SMS: unsent while the deferred transport is pending, remains unsent after it resolves with a provider-level rejection", async () => {
      setEnv({
        APP_ENV: "production",
        APP_URL: "https://paid2you.com",
        TWILIO_ACCOUNT_SID: "AC" + "x".repeat(32),
        TWILIO_AUTH_TOKEN: "t".repeat(32),
        TWILIO_FROM_NUMBER: "+15005550006",
      });
      const deferred = createDeferred<{ ok: boolean; status: number; json: () => Promise<unknown> }>();
      const fetchSpy = vi.fn(async (url: string) => {
        expect(url).toContain("api.twilio.com");
        return deferred.promise as unknown as Response;
      });
      vi.stubGlobal("fetch", fetchSpy);
      const { notificationService, events } = await buildRealNotificationService();

      const notifyPromise = notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_failed", payload: { displayAmount: "$50.00" } });
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

      const preResolution = [...events.byId.values()].find((r) => r.channel === "sms");
      expect(preResolution?.status).not.toBe("sent");
      expect(preResolution?.providerMessageId).toBeNull();

      deferred.resolve({ ok: false, status: 500, json: async () => ({ code: null }) });
      const records = await notifyPromise;

      const smsRecord = records.find((r) => r.channel === "sms")!;
      const updated = await events.findById(smsRecord.id);
      expect(updated?.status).toBe("failed");
      expect(updated?.providerMessageId).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(updated?.attemptCount).toBe(1);
      expect(updated?.nextRetryAt).not.toBeNull();
    });
  });
});
