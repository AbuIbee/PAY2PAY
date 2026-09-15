// Read-only preflight audit (B0-B blocker correction, B0-B-003): identifies every normalized,
// currently-active, verified SMS MFA phone number (mfa_credential.phone_ref where method = 'sms',
// verified_at is set, disabled_at is null) that is associated with MORE THAN ONE DISTINCT user_id.
//
// Why this exists: `mfa_credential` has no database-level uniqueness constraint on phone_ref (confirmed
// by inspecting src/db/schema/auth.ts). DrizzleRegisteredPhoneReader (src/lib/notify/) is written to
// fail closed (ambiguous_match) at the application layer whenever it finds more than one distinct user
// for a phone — that source-level protection is mandatory and does not depend on this script ever being
// run. This script exists only to answer, ahead of any FUTURE decision to add a database uniqueness
// constraint, "does such a constraint already conflict with real data" — running it is NOT a
// prerequisite for the application-layer fix already in place, and it was NOT run against any database
// in the pass that added it (no DATABASE_URL/POSTGRES_URL was configured in that session).
//
// GUARANTEES:
//   - Every statement below is SELECT. Grep this file for "sql`" — there is no INSERT/UPDATE/DELETE/
//     ALTER/DROP/TRUNCATE anywhere, and no other module in this script issues SQL of its own.
//   - No automatic remediation of any kind — this only reports; a human decides what (if anything)
//     to do with the findings, including whether/how to add a uniqueness constraint later.
//   - Requires interactive confirmation before running any query, after printing exactly which
//     host/database/environment will be queried — skip the prompt with --yes or CONFIRM_AUDIT=yes
//     for non-interactive use (e.g. CI), but the environment banner always prints first either way.
//
// Usage: node scripts/audit-duplicate-verified-phones.cjs [--yes]
const postgres = require("postgres");
const readline = require("node:readline");

function looksLikeProduction(hostname, envHints) {
  if (/localhost|127\.0\.0\.1|host\.docker\.internal/i.test(hostname)) return false;
  if (envHints.some((v) => v && /prod/i.test(v))) return true;
  return !/dev|staging|local|test/i.test(hostname);
}

function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

(async () => {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) {
    console.error("FAIL: no database URL available (DATABASE_URL / POSTGRES_URL not set)");
    process.exit(10);
  }

  const u = new URL(url);
  const envHints = [process.env.APP_ENV, process.env.VERCEL_ENV, process.env.VERCEL_TARGET_ENV];
  const isProdLike = looksLikeProduction(u.hostname, envHints);

  console.log("================================================================");
  console.log(" READ-ONLY PREFLIGHT AUDIT — duplicate active verified SMS phones");
  console.log(" (mfa_credential.phone_ref shared across more than one distinct user_id)");
  console.log("================================================================");
  console.log("Host:          ", u.hostname);
  console.log("Database:      ", u.pathname.replace("/", ""));
  console.log("APP_ENV:       ", process.env.APP_ENV || "(not set)");
  console.log("VERCEL_ENV:    ", process.env.VERCEL_ENV || "(not set)");
  console.log("Classified as: ", isProdLike ? "PRODUCTION (or unverified — treated as production)" : "non-production");
  console.log("Operations:     SELECT only. No UPDATE/INSERT/DELETE/schema change/remediation of any kind.");
  console.log("================================================================");
  console.log("");

  const skipPrompt = process.argv.includes("--yes") || /^yes$/i.test(process.env.CONFIRM_AUDIT || "");
  if (!skipPrompt) {
    const answer = await confirm(`Type "yes" to run this read-only audit against ${u.hostname}${u.pathname} : `);
    if (answer !== "yes") {
      console.log("Aborted — no query was run.");
      process.exit(3);
    }
  }
  console.log("");

  const sql = postgres(url, { max: 1, connect_timeout: 10 });

  try {
    console.log("=== Active verified SMS phone numbers shared by more than one distinct user ===");
    const duplicates = await sql`
      select
        phone_ref,
        count(distinct user_id) as distinct_user_count,
        array_agg(distinct user_id) as user_ids,
        count(*) as credential_row_count
      from mfa_credential
      where method = 'sms'
        and verified_at is not null
        and disabled_at is null
        and phone_ref is not null
      group by phone_ref
      having count(distinct user_id) > 1
      order by distinct_user_count desc
    `;
    console.log(duplicates.length ? duplicates : "(none found — no active verified phone is currently shared across distinct users)");
    console.log("");
    console.log(`Result: ${duplicates.length} ambiguous phone number(s) found.`);
    if (duplicates.length > 0) {
      console.log(
        "A database uniqueness constraint on (phone_ref) for active verified SMS credentials would " +
          "currently FAIL against existing data. Do not add one without resolving these rows first. " +
          "The application-layer fail-closed check (DrizzleRegisteredPhoneReader) already protects " +
          "against this regardless.",
      );
    } else {
      console.log(
        "No conflicting data found in this database at this time. This does not retroactively prove " +
          "the application-layer fail-closed check was unnecessary — it remains the primary control. A " +
          "future uniqueness constraint could be considered safe against this snapshot, pending a fresh " +
          "run immediately before applying it.",
      );
    }
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
})();
