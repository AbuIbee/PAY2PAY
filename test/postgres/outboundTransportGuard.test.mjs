import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { test } from "node:test";
import { CLEARED_NOTIFICATION_ENV_KEYS, clearNotificationCredentials, installDefaultDenyOutboundGuard } from "./outboundTransportGuard.mjs";

// Offline only — no real network call is made or attempted anywhere in this file. A fake `globalThis`
// stand-in is used for the fetch-patching tests so this suite never actually mutates the real global
// fetch outside its own assertions.

test("installDefaultDenyOutboundGuard makes fetch throw SYNCHRONOUSLY (never a resolved/rejected Promise) before any network attempt", () => {
  const fakeGlobal = { fetch: async () => ({ ok: true }) };
  const restore = installDefaultDenyOutboundGuard(fakeGlobal);
  try {
    assert.throws(() => fakeGlobal.fetch("https://example.com"), /DEFAULT-DENY OUTBOUND TRANSPORT \(fetch\)/);
  } finally {
    restore();
  }
});

test("installDefaultDenyOutboundGuard makes http.request and http.get throw synchronously", () => {
  const restore = installDefaultDenyOutboundGuard({});
  try {
    assert.throws(() => http.request("http://example.com"), /DEFAULT-DENY OUTBOUND TRANSPORT \(http\.request\)/);
    assert.throws(() => http.get("http://example.com"), /DEFAULT-DENY OUTBOUND TRANSPORT \(http\.get\)/);
  } finally {
    restore();
  }
});

test("installDefaultDenyOutboundGuard makes https.request and https.get throw synchronously", () => {
  const restore = installDefaultDenyOutboundGuard({});
  try {
    assert.throws(() => https.request("https://example.com"), /DEFAULT-DENY OUTBOUND TRANSPORT \(https\.request\)/);
    assert.throws(() => https.get("https://example.com"), /DEFAULT-DENY OUTBOUND TRANSPORT \(https\.get\)/);
  } finally {
    restore();
  }
});

// "Prove guard removal makes the test fail" — demonstrates the earlier assertions are actually
// exercising the guard's own behavior, not some unrelated always-throwing default.
test("restore() puts back the ORIGINAL functions — after restore, the same call no longer throws the guard's deny error (proving the guard, not something else, was the cause)", () => {
  const originalHttpRequest = http.request;
  const restore = installDefaultDenyOutboundGuard({});
  assert.notEqual(http.request, originalHttpRequest, "guard must have actually replaced http.request");
  restore();
  assert.equal(http.request, originalHttpRequest, "restore() must put back the exact original reference");
});

test("installDefaultDenyOutboundGuard does NOT touch node:net or node:tls — the approved local Postgres transport (the `postgres` npm package speaks the wire protocol directly over net/tls, never fetch/http/https) remains allowed by policy, without this test ever opening a real socket", async () => {
  const net = await import("node:net");
  const tls = await import("node:tls");
  const originalNetConnect = net.connect;
  const originalTlsConnect = tls.connect;
  const restore = installDefaultDenyOutboundGuard({});
  try {
    assert.equal(net.connect, originalNetConnect, "the guard must never patch net.connect");
    assert.equal(tls.connect, originalTlsConnect, "the guard must never patch tls.connect");
  } finally {
    restore();
  }
});

test("clearNotificationCredentials deletes every enumerated notification credential/switch from the given env object", () => {
  const fakeEnv = {
    RESEND_API_KEY: "re_leftover",
    EMAIL_FROM_ADDRESS: "leftover@example.com",
    TWILIO_ACCOUNT_SID: "ACleftover",
    TWILIO_AUTH_TOKEN: "leftovertoken",
    UNRELATED_VAR: "must-survive",
  };
  clearNotificationCredentials(fakeEnv);
  for (const key of CLEARED_NOTIFICATION_ENV_KEYS) {
    assert.equal(key in fakeEnv, false, `${key} must be deleted, not merely set to undefined`);
  }
  assert.equal(fakeEnv.UNRELATED_VAR, "must-survive", "clearNotificationCredentials must never touch an unrelated variable");
});

test("clearNotificationCredentials is idempotent — calling it twice on an already-clean env does not throw", () => {
  const fakeEnv = {};
  assert.doesNotThrow(() => {
    clearNotificationCredentials(fakeEnv);
    clearNotificationCredentials(fakeEnv);
  });
});

test("CLEARED_NOTIFICATION_ENV_KEYS matches the actual env keys getEmailSender.ts/getSmsSender.ts/env.ts consult (enumerated by inspection, not invented) — a regression here would silently reopen the credential-leak gap", () => {
  const expected = [
    "RESEND_API_KEY",
    "EMAIL_FROM_ADDRESS",
    "EMAIL_DELIVERY_ENABLED",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_MESSAGING_SERVICE_SID",
    "TWILIO_FROM_NUMBER",
    "SMS_DELIVERY_ENABLED",
  ];
  assert.deepEqual([...CLEARED_NOTIFICATION_ENV_KEYS], expected);
});
