// Read-only pre-flight (connection P2P-EZ2R-V3MM / P2P-T7UJ-JM2W remediation): gathers the exact
// facts needed to write the final remediation UPDATE — the two bad payout assignment ids, their
// current status/timestamps, each relationship's own status and linked agreement, and a live check
// (not just a code-review inference) that nothing in ach_mandate / debit_card_method / payment_attempt
// references the affected financial_account via the assignment being retired.
//
// GUARANTEES: SELECT-only. No INSERT/UPDATE/DELETE/schema change anywhere in this file. Requires
// typed "yes" confirmation before querying, same as audit-relationship-financial-accounts.cjs.
//
// Usage: node scripts/audit-payout-remediation-preflight.cjs [--yes]
const postgres = require("postgres");
const readline = require("node:readline");

const TARGET_REFERENCES = ["P2P-EZ2R-V3MM", "P2P-T7UJ-JM2W"];

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

  console.log("================================================================");
  console.log(" READ-ONLY PRE-FLIGHT — payout-assignment remediation facts");
  console.log(" Targets:", TARGET_REFERENCES.join(", "));
  console.log("================================================================");
  console.log("Host:          ", u.hostname);
  console.log("Database:      ", u.pathname.replace("/", ""));
  console.log("Operations:     SELECT only. No writes of any kind.");
  console.log("================================================================");
  console.log("");

  const skipPrompt = process.argv.includes("--yes") || /^yes$/i.test(process.env.CONFIRM_AUDIT || "");
  if (!skipPrompt) {
    const answer = await confirm(`Type "yes" to run this read-only pre-flight against ${u.hostname}${u.pathname} : `);
    if (answer !== "yes") {
      console.log("Aborted — no query was run.");
      process.exit(3);
    }
  }
  console.log("");

  const sql = postgres(url, { max: 1, connect_timeout: 10 });

  try {
    for (const ref of TARGET_REFERENCES) {
      console.log("================================================================");
      console.log(" ", ref);
      console.log("================================================================");

      const rel = await sql`
        select id, public_reference, status, current_agreement_id
        from relationship
        where public_reference = ${ref}
      `;
      if (!rel.length) {
        console.log("  NOT FOUND on this database.");
        continue;
      }
      const relationshipId = rel[0].id;
      console.log("relationship:", rel[0]);

      if (rel[0].current_agreement_id) {
        const agr = await sql`
          select id, status, debtor_profile_kind, debtor_profile_id, creditor_profile_kind, creditor_profile_id
          from agreement
          where id = ${rel[0].current_agreement_id}
        `;
        console.log("linked agreement:", agr[0] ?? "(not found)");
      } else {
        console.log("linked agreement: (none)");
      }

      const assignments = await sql`
        select
          rfa.id as assignment_id,
          rfa.usage,
          rfa.status,
          rfa.effective_from,
          rfa.effective_to,
          rfa.superseded_by,
          rfa.relationship_participant_id,
          rp.role as participant_role,
          fa.id as financial_account_id,
          fa.institution_display_name,
          fa.masked_last4,
          fa.status as account_status
        from relationship_financial_account rfa
        join relationship_participant rp on rp.id = rfa.relationship_participant_id
        join financial_account fa on fa.id = rfa.financial_account_id
        where rfa.relationship_id = ${relationshipId}
        order by rfa.usage, rfa.created_at
      `;
      console.log("all funding/payout assignments (active + historical):");
      console.log(assignments);

      const badPayout = assignments.find((a) => a.usage === "payout" && a.status === "active" && a.participant_role !== "creditor");
      if (!badPayout) {
        console.log("No active payout assignment with a non-creditor participant found for this relationship — nothing to remediate here (re-check manually).");
        continue;
      }
      console.log("");
      console.log(">>> INVALID PAYOUT ASSIGNMENT TO RETIRE:", badPayout.assignment_id, "<<<");

      const mandateRefs = await sql`
        select id, agreement_id, status, financial_account_id
        from ach_mandate
        where financial_account_id = ${badPayout.financial_account_id}
      `;
      console.log(`ach_mandate rows referencing this financial_account (${badPayout.financial_account_id}):`, mandateRefs.length);
      if (mandateRefs.length) console.log(mandateRefs);

      const cardRefs = await sql`
        select id, agreement_id, status, financial_account_id
        from debit_card_method
        where financial_account_id = ${badPayout.financial_account_id}
      `;
      console.log(`debit_card_method rows referencing this financial_account:`, cardRefs.length);
      if (cardRefs.length) console.log(cardRefs);

      const paymentRefs = await sql`
        select id, agreement_id, status, bank_connection_id, payer_profile_id, recipient_profile_id
        from payment_attempt
        where bank_connection_id = ${badPayout.financial_account_id}
      `;
      console.log(`payment_attempt rows referencing this financial_account as bank_connection_id:`, paymentRefs.length);
      if (paymentRefs.length) console.log(paymentRefs);

      console.log("");
    }

    console.log("PRE-FLIGHT COMPLETE — no rows were modified.");
  } catch (e) {
    console.error("PRE-FLIGHT FAILED");
    console.error("Name:", e.name || "unknown");
    console.error("Code:", e.code || "none");
    console.error("Message:", e.message || String(e));
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
})();
