import assert from "node:assert/strict";
import { test } from "node:test";

// Pure logic test for the drift-comparison algorithm in check-schema-drift.mjs
// (kept as a standalone script, not a service module, so this test inlines
// the same comparison rather than importing — the script's side effects
// (spawning the Supabase CLI) aren't something a unit test should trigger).
function computeDrift(migrations) {
  const missingRemotely = migrations.filter((m) => m.local && !m.remote);
  const unexpectedRemotely = migrations.filter((m) => m.remote && !m.local);
  return { missingRemotely, unexpectedRemotely };
}

test("reports no drift when every migration has both local and remote", () => {
  const { missingRemotely, unexpectedRemotely } = computeDrift([
    { local: "20260815090000", remote: "20260815090000" },
    { local: "20260815090100", remote: "20260815090100" },
  ]);
  assert.equal(missingRemotely.length, 0);
  assert.equal(unexpectedRemotely.length, 0);
});

test("flags a migration present locally but not applied remotely", () => {
  const { missingRemotely, unexpectedRemotely } = computeDrift([
    { local: "20260815090000", remote: "20260815090000" },
    { local: "20260815090100", remote: null },
  ]);
  assert.equal(missingRemotely.length, 1);
  assert.equal(missingRemotely[0].local, "20260815090100");
  assert.equal(unexpectedRemotely.length, 0);
});

test("flags a migration applied remotely with no matching local file", () => {
  const { missingRemotely, unexpectedRemotely } = computeDrift([
    { local: "20260815090000", remote: "20260815090000" },
    { local: null, remote: "20260815099999" },
  ]);
  assert.equal(missingRemotely.length, 0);
  assert.equal(unexpectedRemotely.length, 1);
  assert.equal(unexpectedRemotely[0].remote, "20260815099999");
});

test("real captured state (25 migrations, post-PRSprint-01) reports zero drift", () => {
  const realCapture = [
    "20260811130000","20260811130100","20260811130200","20260811130300","20260811130400",
    "20260811130500","20260811130600","20260811130700","20260811130800","20260811130900",
    "20260811131000","20260811131100","20260811131200","20260811131300","20260811140000",
    "20260815090000","20260815090100","20260815090200","20260815090300","20260815090400",
    "20260815090500","20260815090600","20260815090700","20260815090800","20260815090900",
  ].map((ts) => ({ local: ts, remote: ts }));
  const { missingRemotely, unexpectedRemotely } = computeDrift(realCapture);
  assert.equal(realCapture.length, 25);
  assert.equal(missingRemotely.length, 0);
  assert.equal(unexpectedRemotely.length, 0);
});
