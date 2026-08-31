// Read-only, platform-wide audit tool (originally written for connection P2P-EZ2R-V3MM's remediation,
// generalized per "the security rule is platform-wide — do not scope future protection to specific
// relationships"): checks the ENTIRE relationship_financial_account / financial_account dataset for
// the corruption patterns this incident class covers — an assignment's usage not matching its
// participant's role (funding must be the debtor's, payout must be the creditor's), an assignment
// whose financial_account is not actually owned by the participant it's attached to (at the profile
// level), the same account active in both slots of one relationship, duplicate active assignments for
// a single slot, and a cross-user assignment (the same authorization boundary as the ownership check,
// re-derived independently at the user-id level for defense-in-depth). Checks 2-6 below always scan
// every relationship on the database — nothing is scoped to any specific connection unless you ask.
//
// GUARANTEES:
//   - Every statement below is SELECT. Grep this file for "sql`" — there is no INSERT/UPDATE/DELETE/
//     ALTER/DROP/TRUNCATE anywhere, and no other module in this script issues SQL of its own.
//   - No automatic remediation of any kind — this only reports; a human decides what (if anything)
//     to do with the findings.
//   - Requires interactive confirmation before running any query, after printing exactly which
//     host/database/environment will be queried — skip the prompt with --yes or CONFIRM_AUDIT=yes
//     for non-interactive use (e.g. CI), but the environment banner always prints first either way.
//
// Usage: node scripts/audit-relationship-financial-accounts.cjs [--yes] [--reference=P2P-XXXX-XXXX[,P2P-YYYY-YYYY,...]]
//   --reference is optional — omit it to run the platform-wide checks only. Pass one or more public
//   references (comma-separated) to additionally dump those specific connections' own rows and see
//   whether each one appears in the platform-wide flagged sets.
const postgres = require("postgres");
const readline = require("node:readline");

function looksLikeProduction(hostname, envHints) {
  if (/localhost|127\.0\.0\.1|host\.docker\.internal/i.test(hostname)) return false;
  if (envHints.some((v) => v && /prod/i.test(v))) return true;
  // Supabase/Vercel-managed hosts with no explicit "dev"/"staging"/"local" hint default to "unknown,
  // treat as production" — the whole point of this banner is to never let an ambiguous host slide by.
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

  const referenceArg = process.argv.find((a) => a.startsWith("--reference="));
  const references = referenceArg
    ? referenceArg
        .slice("--reference=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const u = new URL(url);
  const envHints = [process.env.APP_ENV, process.env.VERCEL_ENV, process.env.VERCEL_TARGET_ENV];
  const isProdLike = looksLikeProduction(u.hostname, envHints);

  console.log("================================================================");
  console.log(" READ-ONLY PLATFORM-WIDE AUDIT — relationship_financial_account / financial_account");
  console.log("================================================================");
  console.log("Host:          ", u.hostname);
  console.log("Database:      ", u.pathname.replace("/", ""));
  console.log("APP_ENV:       ", process.env.APP_ENV || "(not set)");
  console.log("VERCEL_ENV:    ", process.env.VERCEL_ENV || "(not set)");
  console.log("Classified as: ", isProdLike ? "PRODUCTION (or unverified — treated as production)" : "non-production");
  console.log("References:    ", references.length ? references.join(", ") : "(none — platform-wide checks only)");
  console.log("Operations:     SELECT only. No UPDATE/INSERT/DELETE/schema change/remediation of any kind.");
  console.log("================================================================");
  console.log("");

  const skipPrompt = process.argv.includes("--yes") || /^yes$/i.test(process.env.CONFIRM_AUDIT || "");
  if (!skipPrompt) {
    const answer = await confirm(
      `Type "yes" to run this read-only audit against ${u.hostname}${u.pathname} : `,
    );
    if (answer !== "yes") {
      console.log("Aborted — no query was run.");
      process.exit(3);
    }
  }
  console.log("");

  const sql = postgres(url, { max: 1, connect_timeout: 10 });
  const findings = {};

  try {
    findings.reportedConnections = {};
    if (references.length) {
      for (const ref of references) {
        console.log(`=== 1. Specific connection: ${ref} ===`);
        const rows = await sql`
          select
            r.id as relationship_id,
            r.public_reference,
            r.status as relationship_status,
            rfa.id as assignment_id,
            rfa.usage,
            rfa.status as assignment_status,
            rp.id as participant_id,
            rp.role as participant_role,
            rp.individual_profile_id as participant_individual_profile_id,
            rp.organization_id as participant_organization_id,
            fa.id as financial_account_id,
            fa.individual_profile_id as account_individual_profile_id,
            fa.organization_id as account_organization_id,
            fa.institution_display_name,
            fa.masked_last4,
            fa.status as account_status
          from relationship r
          join relationship_financial_account rfa on rfa.relationship_id = r.id
          join relationship_participant rp on rp.id = rfa.relationship_participant_id
          join financial_account fa on fa.id = rfa.financial_account_id
          where r.public_reference = ${ref}
          order by rfa.usage, rfa.status desc, rfa.created_at
        `;
        findings.reportedConnections[ref] = rows;
        console.log(rows.length ? rows : "(no rows — relationship not found by that public_reference)");
        console.log("");
      }
    } else {
      console.log("=== 1. Specific connection dump ===");
      console.log("(no --reference provided — skipping specific-connection dump; running platform-wide checks only)");
      console.log("");
    }

    console.log("=== 2. Active assignments whose usage does not match the assigned participant's role ===");
    console.log("    (funding must belong to the debtor participant; payout must belong to the creditor participant)");
    console.log("    (platform-wide — every relationship on this database, not just the ones above)");
    const roleMismatches = await sql`
      select
        r.public_reference,
        rfa.id as assignment_id,
        rfa.relationship_id,
        rfa.usage,
        rp.role as participant_role,
        rp.id as participant_id
      from relationship_financial_account rfa
      join relationship_participant rp on rp.id = rfa.relationship_participant_id
      join relationship r on r.id = rfa.relationship_id
      where rfa.status = 'active'
        and (
          (rfa.usage = 'funding' and rp.role <> 'debtor')
          or (rfa.usage = 'payout' and rp.role <> 'creditor')
        )
    `;
    findings.usageRoleMismatches = roleMismatches;
    console.log(`Found ${roleMismatches.length} mismatched active assignment(s).`);
    if (roleMismatches.length) console.log(roleMismatches);

    console.log("");
    console.log("=== 3. Active assignments whose financial_account is not owned by the attached participant (profile-level) ===");
    console.log("    (platform-wide)");
    const ownershipMismatches = await sql`
      select
        r.public_reference,
        rfa.id as assignment_id,
        rfa.relationship_id,
        rfa.usage,
        rp.id as participant_id,
        rp.individual_profile_id as participant_individual_profile_id,
        rp.organization_id as participant_organization_id,
        fa.id as financial_account_id,
        fa.individual_profile_id as account_individual_profile_id,
        fa.organization_id as account_organization_id
      from relationship_financial_account rfa
      join relationship_participant rp on rp.id = rfa.relationship_participant_id
      join financial_account fa on fa.id = rfa.financial_account_id
      join relationship r on r.id = rfa.relationship_id
      where rfa.status = 'active'
        and not (
          (fa.individual_profile_id is not null and fa.individual_profile_id = rp.individual_profile_id)
          or (fa.organization_id is not null and fa.organization_id = rp.organization_id)
        )
    `;
    findings.ownershipMismatches = ownershipMismatches;
    console.log(`Found ${ownershipMismatches.length} ownership mismatch(es).`);
    if (ownershipMismatches.length) console.log(ownershipMismatches);

    console.log("");
    console.log("=== 4. Relationships where the SAME financial_account is active in both the funding and payout slots ===");
    console.log("    (platform-wide)");
    const sameAccountBothSlots = await sql`
      select
        r.public_reference,
        f.relationship_id,
        f.id as funding_assignment_id,
        p.id as payout_assignment_id,
        f.financial_account_id as shared_financial_account_id
      from relationship r
      join relationship_financial_account f
        on f.relationship_id = r.id and f.usage = 'funding' and f.status = 'active'
      join relationship_financial_account p
        on p.relationship_id = r.id and p.usage = 'payout' and p.status = 'active'
      where f.financial_account_id = p.financial_account_id
    `;
    findings.sameAccountBothSlots = sameAccountBothSlots;
    console.log(`Found ${sameAccountBothSlots.length} relationship(s) with the same account in both slots.`);
    if (sameAccountBothSlots.length) console.log(sameAccountBothSlots);

    console.log("");
    console.log("=== 5a. Relationships with more than one ACTIVE funding assignment ===");
    console.log("     (should be impossible — the DB has a partial unique index on (relationship_id, usage) where status='active' — this is a sanity check; platform-wide)");
    const duplicateActiveFunding = await sql`
      select relationship_id, count(*) as active_count
      from relationship_financial_account
      where status = 'active' and usage = 'funding'
      group by relationship_id
      having count(*) > 1
    `;
    findings.duplicateActiveFunding = duplicateActiveFunding;
    console.log(`Found ${duplicateActiveFunding.length} relationship(s) with more than one active funding assignment.`);
    if (duplicateActiveFunding.length) console.log(duplicateActiveFunding);

    console.log("");
    console.log("=== 5b. Relationships with more than one ACTIVE payout assignment ===");
    console.log("     (platform-wide)");
    const duplicateActivePayout = await sql`
      select relationship_id, count(*) as active_count
      from relationship_financial_account
      where status = 'active' and usage = 'payout'
      group by relationship_id
      having count(*) > 1
    `;
    findings.duplicateActivePayout = duplicateActivePayout;
    console.log(`Found ${duplicateActivePayout.length} relationship(s) with more than one active payout assignment.`);
    if (duplicateActivePayout.length) console.log(duplicateActivePayout);

    console.log("");
    console.log("=== 6. Cross-user assignment (user-id-level view — defense-in-depth on top of check 3's profile-level check) ===");
    console.log("    Resolves ownership via personal_profile.user_id / business_profile.owner_user_id, the same profile-based");
    console.log("    authorization boundary the app itself uses (never financial_account.added_by_user_id, which legitimately");
    console.log("    differs from the owner for a business account added by authorized staff). Platform-wide.");
    const crossUserAssignments = await sql`
      select
        r.public_reference,
        rfa.id as assignment_id,
        rfa.relationship_id,
        rfa.usage,
        rfa.financial_account_id,
        fa.added_by_user_id,
        coalesce(pp_acct.user_id, bp_acct.owner_user_id) as account_owning_user_id,
        rp.id as participant_id,
        rp.role as participant_role,
        coalesce(pp_part.user_id, bp_part.owner_user_id) as participant_owning_user_id
      from relationship_financial_account rfa
      join relationship r on r.id = rfa.relationship_id
      join relationship_participant rp on rp.id = rfa.relationship_participant_id
      join financial_account fa on fa.id = rfa.financial_account_id
      left join personal_profile pp_acct on pp_acct.id = fa.individual_profile_id
      left join business_profile bp_acct on bp_acct.id = fa.organization_id
      left join personal_profile pp_part on pp_part.id = rp.individual_profile_id
      left join business_profile bp_part on bp_part.id = rp.organization_id
      where rfa.status = 'active'
        and coalesce(pp_acct.user_id, bp_acct.owner_user_id)
            is distinct from coalesce(pp_part.user_id, bp_part.owner_user_id)
    `;
    findings.crossUserAssignments = crossUserAssignments;
    console.log(`Found ${crossUserAssignments.length} cross-user assignment(s).`);
    if (crossUserAssignments.length) console.log(crossUserAssignments);

    const perReferenceFlags = {};
    for (const ref of references) {
      const rows = findings.reportedConnections[ref] ?? [];
      const relationshipId = rows[0]?.relationship_id ?? null;
      perReferenceFlags[ref] = relationshipId
        ? {
            found: true,
            appearsInUsageRoleMismatches: roleMismatches.some((r) => r.relationship_id === relationshipId),
            appearsInOwnershipMismatches: ownershipMismatches.some((r) => r.relationship_id === relationshipId),
            appearsInSameAccountBothSlots: sameAccountBothSlots.some((r) => r.relationship_id === relationshipId),
            appearsInDuplicateActiveFunding: duplicateActiveFunding.some((r) => r.relationship_id === relationshipId),
            appearsInDuplicateActivePayout: duplicateActivePayout.some((r) => r.relationship_id === relationshipId),
            appearsInCrossUserAssignments: crossUserAssignments.some((r) => r.relationship_id === relationshipId),
          }
        : { found: false, note: `${ref} was not found by public_reference on this database.` };
    }

    console.log("");
    console.log("=== SUMMARY ===");
    if (references.length) {
      console.log("Does each requested reference appear in any platform-wide flagged set above?");
      console.log(perReferenceFlags);
    } else {
      console.log("No --reference provided — platform-wide counts only (see counts below); no per-connection cross-reference to show.");
    }

    console.log("");
    console.log("=== JSON SUMMARY (paste this back for analysis) ===");
    const jsonSummary = {
      host: u.hostname,
      database: u.pathname.replace("/", ""),
      classifiedAsProduction: isProdLike,
      counts: {
        usageRoleMismatches: roleMismatches.length,
        ownershipMismatches: ownershipMismatches.length,
        sameAccountBothSlots: sameAccountBothSlots.length,
        duplicateActiveFunding: duplicateActiveFunding.length,
        duplicateActivePayout: duplicateActivePayout.length,
        crossUserAssignments: crossUserAssignments.length,
      },
    };
    if (references.length) {
      jsonSummary.referencedConnections = perReferenceFlags;
    }
    console.log(JSON.stringify(jsonSummary, null, 2));

    console.log("");
    console.log("AUDIT COMPLETE — every statement above was SELECT-only. No rows were modified.");
  } catch (e) {
    console.error("AUDIT FAILED");
    console.error("Name:", e.name || "unknown");
    console.error("Code:", e.code || "none");
    console.error("Message:", e.message || String(e));
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
})();
