import http from "node:http";
import https from "node:https";

/**
 * STAGE 2 CRITICAL REMEDIATION — FIX 02 (default-deny outbound traffic for the PostgreSQL
 * integration-test process). Inventory performed before writing this file:
 *
 *   - `src/**\/*.postgres.test.ts` (8 files) were grepped for `fetch(`, `axios`, `node-fetch`,
 *     `https?.request`, `XMLHttpRequest`, `WebSocket(`, `getEmailSender`, `getSmsSender`,
 *     `ResendEmailSender`, `TwilioSmsSender`, `RESEND_API_KEY`, `TWILIO_ACCOUNT_SID`,
 *     `getPaymentProvider(` — zero matches for any of the transport/SDK patterns. The only
 *     provider-shaped dependency any of them import is `@/test-support/payments/sandboxPaymentProvider`
 *     (`SandboxPaymentProvider`), which was itself grepped for `fetch(`/`http`/`axios` — zero matches:
 *     it is a pure in-process fake with no network transport of its own. The only notification
 *     dependency any of them import is `createTestNotificationService` (`@/lib/notify/testFakes`),
 *     which wires `InMemoryEmailSender`/`InMemorySmsSender` — never the real
 *     `getEmailSender()`/`getSmsSender()` factories, never `ResendEmailSender`/`TwilioSmsSender`.
 *   - The actual local PostgreSQL transport is the `postgres` npm package, which speaks the Postgres
 *     wire protocol directly over `node:net`/`node:tls` sockets — it does not use `fetch`, `http`, or
 *     `https` at all. This guard therefore never touches `net`/`tls`/`dns` — blocking `fetch`/`http`/
 *     `https` cannot interfere with the approved local database connection.
 *
 * Scope disclosure (claim only what is actually implemented and tested): this is an
 * APPLICATION-LEVEL (Node process global-function) interception, installed once per Vitest worker
 * process via `vitest.postgres.setup.ts`. It is NOT OS-level network isolation (no firewall, no
 * network namespace, no container egress policy) — a transport that opens its own raw `net`/`tls`
 * socket without going through `fetch`/`http`/`https` (e.g. a hypothetical custom binary-protocol SDK)
 * would not be caught by this guard. No such transport was identified in the current reachable code
 * (every external call found anywhere in this codebase's provider/notification senders uses `fetch`
 * directly — see `resendEmailSender.ts`/`twilioSmsSender.ts`), so this is a disclosed scope boundary,
 * not a silently-ignored gap.
 */

export const CLEARED_NOTIFICATION_ENV_KEYS = [
  "RESEND_API_KEY",
  "EMAIL_FROM_ADDRESS",
  "EMAIL_DELIVERY_ENABLED",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_MESSAGING_SERVICE_SID",
  "TWILIO_FROM_NUMBER",
  "SMS_DELIVERY_ENABLED",
];

/** Deletes every notification-provider credential/switch from `env` BEFORE any test module has a
 * chance to import a real sender factory and memoize a live-configured client into its module-level
 * cache — mirrors the identical `establishCleanNotifyBaseline` pattern already proven in
 * `src/lib/notify/productionFailClosed.test.ts` (Stage 1, SV-011). Idempotent; safe to call multiple
 * times. */
export function clearNotificationCredentials(env = process.env) {
  for (const key of CLEARED_NOTIFICATION_ENV_KEYS) {
    delete env[key];
  }
}

function denyMessage(transport) {
  return (
    `TEST-ONLY DEFAULT-DENY OUTBOUND TRANSPORT (${transport}): the PostgreSQL integration suite must ` +
    "never make a real network call other than to its own approved disposable database. If this test " +
    "genuinely needs an external call, it must use an explicit, controlled, non-network test double " +
    "instead — never remove this guard to make a real call succeed."
  );
}

/**
 * Installs a synchronous, always-throwing replacement for `globalThis.fetch`, `http.request`,
 * `http.get`, `https.request`, and `https.get`. Throwing SYNCHRONOUSLY (not returning a rejected
 * Promise) means a caller that does `await fetch(...)` never even reaches the `await` — the exception
 * fires at the call expression itself, before any DNS lookup or socket could be opened, matching this
 * fix's own "fail immediately without transmission" requirement.
 *
 * Returns a `restore()` function that puts back the exact original references — call it once per
 * process (this repository's `vitest.postgres.config.ts` runs a single fork for the whole suite, so in
 * practice `restore()` is only needed by this guard's own offline unit test, never by production
 * harness code).
 */
export function installDefaultDenyOutboundGuard(target = globalThis) {
  const originalFetch = target.fetch;
  const originalHttpRequest = http.request;
  const originalHttpGet = http.get;
  const originalHttpsRequest = https.request;
  const originalHttpsGet = https.get;

  target.fetch = () => {
    throw new Error(denyMessage("fetch"));
  };
  http.request = () => {
    throw new Error(denyMessage("http.request"));
  };
  http.get = () => {
    throw new Error(denyMessage("http.get"));
  };
  https.request = () => {
    throw new Error(denyMessage("https.request"));
  };
  https.get = () => {
    throw new Error(denyMessage("https.get"));
  };

  return function restore() {
    target.fetch = originalFetch;
    http.request = originalHttpRequest;
    http.get = originalHttpGet;
    https.request = originalHttpsRequest;
    https.get = originalHttpsGet;
  };
}
