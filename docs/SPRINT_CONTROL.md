# Sprint Control

Tracks status, dependencies, and sequencing for the 20 sprint files in `docs/sprints/`
(`SPRINT_01_...` through `SPRINT_20_...`). Companion document: `docs/SPRINT_REQUIREMENTS_MATRIX.md`
(per-sprint requirement-ID mapping).

**Revision 2** — repair pass. Resolves the two High-severity findings from Revision 1 (§17 full
identity verification, §26 MFA — both previously "STOPPED — REQUIREMENT/DEPENDENCY CONFLICT
FOUND") plus the Medium-severity §19 pricing gap and the Low-severity §28 retention gap, by editing
Sprints 2, 3, 4, 6, 9, 15, 18, and 20. No application code was implemented; these are sprint-plan
document edits only.

## A. File existence

Unchanged from Revision 1 — all 20 sprint files exist in `docs/sprints/`, filenames match.

## B. Duplicate primary-scope analysis (re-run)

**Still no two sprints claim the same primary deliverable**, including after this repair pass's
additions. Every new cross-sprint reference added in this repair is a *consumer* calling a
*primitive/interface owned by exactly one sprint* — not a second implementation of the same thing:

- Sprint 2 owns the MFA/step-up primitive (`requireStepUp`). Sprints 4, 6, and 15 call it; none of
  them re-implement MFA.
- Sprint 3 owns the identity-verification architecture (state model, `isFullyVerified` interface)
  and the pricing/account-plan architecture. Sprint 6 and Sprint 9 call `isFullyVerified`; Sprint 12
  reads the pricing model. None re-implement either.
- Sprint 9 owns the actual KYC/KYB provider integration, kept as a second, explicitly non-merged
  interface alongside its existing (unchanged) payment-provider abstraction. Sprint 3 owns the
  architecture the integration fills in — the split mirrors the existing Sprint 5/Sprint 9 pattern
  (domain logic vs. provider integration) already present in the plan before this repair.
- Sprint 18 owns retention/legal-hold *operations* (placing, releasing, auditing holds). Sprint 20
  *verifies* that behavior as part of its existing role as the terminal readiness gate — the same
  build-then-gate relationship Sprint 20 already has with every other sprint's output (e.g., Sprint
  19's security hardening).

`docs/SPRINT_DUPLICATION_REPORT.md` was **not created** in Revision 1 and remains unnecessary now.

## C. Comparison against the master specification (re-run)

- Every sprint's primary scope still traces cleanly to a master-spec section and requirement ID —
  see `docs/SPRINT_REQUIREMENTS_MATRIX.md` for the full mapping, including the rows changed by this
  repair.
- Money-handling and agreement-state-vocabulary consistency findings from Revision 1 are unchanged
  (still consistent, no conflicts).
- Of the four gaps identified in Revision 1 (§17, §26, §19, §28), **three of the four (§17, §26,
  §19) are resolved by this repair pass, plus §28 (retention), which Revision 1 had scored Low
  severity** — all four now have an owning sprint. See "Resolved in this repair pass" in
  `docs/SPRINT_REQUIREMENTS_MATRIX.md`.
- **One Medium-severity item from Revision 1 remains open and was not part of this repair's
  instruction list:** Sprint 17 (Notifications) is still sequenced after several sprints (5, 6, 8,
  13, 14, 15, 16) that reference "notify" as required functionality. See Sequencing risk 1 below —
  carried forward, reassessed as non-blocking.

## D. Dependency graph and sequencing (re-run)

```
1 (standalone — deploy/marketing)

2 (auth, base profile, MFA primitive) ─▶ 3 (full profiles, verification architecture,
        │                                    pricing architecture)
        │                                        │         │
        │                                        ▼         ▼
        │                                  4 (staff/RBAC)  ...
        │                                        │
        │              ┌─────────────────────────┘
        ▼              ▼
  6 (signatures) ◀── 5 (agreement engine)
        │                    │
        │        ┌───────────┼───────────────┐
        │        ▼            ▼               ▼
        │  7 (evidence/  8 (B2B workflows/
        │   witnesses)     CSV import)
        │
        └── depends on 2 (requireStepUp) + 3 (isFullyVerified) — both precede 6 ✓

3 (verification architecture) ─▶ 9 (payment abstraction + KYC/KYB integration,
                                      enforces isFullyVerified once at payment creation)
                                        │
                                        ▼
                                  10 (ledger) ─▶ 11 (ACH) ─▶ 12 (debit card, reads
                                                │                 3's pricing model)
                                                ▼
                                          13 (failed payments/retry)

14 (amendments/hardship) ─┐
15 (partial/settlement,   ├─▶ depend on 5's versioning + lifecycle states;
    calls 2's requireStepUp) 15 also depends on 2 (MFA) — precedes it ✓
16 (disputes)             ┘   16 also depends on 11/12 for payment-dispute raw state

17 (notifications) ─── consumed by 5, 6, 8, 13, 14, 15, 16 (Sequencing risk 1, open, non-blocking)

18 (admin/support/appeals, retention/legal holds) ─▶ depends on 16 (dispute review),
                               3/9 (verification review, now resolvable), owns hold operations
19 (fraud/risk/security)   ─▶ depends on nearly everything existing to test against
20 (closed beta readiness, ─▶ terminal gate; now also verifies Sprint 18's retention holds
    retention verification)    end-to-end, including a restore drill covering held records
```

Every dependency edge added or clarified by this repair points **backward** (to a lower-numbered
sprint) or to itself — no new forward reference was introduced. The two High-severity forward
references from Revision 1 (Sprint 6 → nonexistent MFA/verification; Sprints 9–12 → nonexistent
MFA/verification) are now backward references (Sprint 6 → Sprints 2, 3; Sprint 9 → Sprint 3).

### Sequencing risk 1 — Notifications built after seven sprints already reference it (carried forward, reassessed)

Unchanged from Revision 1: Sprint 17 is sequenced 17th; Sprints 5, 6, 8, 13, 14, 15, 16 reference
"notify" before it exists. **Not in this repair's instruction list, so not edited.** Reassessed
severity: **Medium, non-blocking** — unlike the §17/§26 case, a viable implementation exists
without contradiction or rework: earlier sprints write to an internal notification-events
record/table (which requires no infrastructure beyond a database write), and Sprint 17 later wires
real delivery channels (email/SMS/in-app) on top of the existing event records. This does not
require any earlier sprint to be rebuilt when Sprint 17 lands. Recommend documenting this
interpretation explicitly in Sprints 5/6/8/13/14/15/16 in a future pass, but it does not block
execution.

## E. Status

| Sprint | Status |
|---|---|
| 1 | **COMPLETE.** All 13 required-work items and all 8 acceptance criteria in `docs/sprints/SPRINT_01_PublicPreview _VercelReadiness.md` satisfied. Tests: 99/99 passing (18 files). Build: succeeds. Git commit: `82b2d98` ("Complete Sprint 1 public preview and early access") — verified present on `master`, contents match this sprint's file list. Vercel preview/production reference: `https://paid2you.com` — fetched and confirmed live, serving this build (disclaimer copy matches verbatim). ChatGPT/Product Owner review: **PASS**. Full report in `docs/PROGRESS.md`. |
| 2 | **Local verification complete; branch/CI/Vercel status pending.** All 12 required-functionality items and the MFA/step-up primitive from `docs/sprints/SPRINT_02_Authentication.md` implemented on branch `sprint-02-authentication`. Local `lint`/`typecheck`/`test`/`build` all pass (165/165 tests). Architecture decision flagged for review: Supabase Auth **not** adopted (documented blocker, see `docs/AUTHENTICATION.md` §1); passkey/WebAuthn deliberately deferred (§4). Git commit / GitHub CI / Vercel preview: see below, pending this step's push. |
| 3–20 | Not started. Sprint plan documents for 3, 4, 6, 9, 15, 18, 20 were revised in the earlier repair pass; no application code has been implemented for any of them. |

### Sprint 2 branch/CI/Vercel record

- **Branch:** `sprint-02-authentication` (not merged into `master`; per governance, this sprint does not merge or deploy to production).
- **Commit:** _pending — recorded after commit below._
- **GitHub CI:** _pending — see note below on the workflow's trigger scope._
- **Vercel preview:** _pending — no Vercel CLI/API access in this environment; see note below._

## F. Duplication report

Not created — no duplicate primary scope was found in Revision 1 or this re-run (Section B).

## G. Structural-safety determination (re-run)

Both High-severity conflicts from Revision 1 are resolved with correctly-sequenced, backward-only
dependencies:

- **§17 Identity verification**: architecture (Sprint 3) precedes and is called by both its
  consumers (Sprint 6 for signing, Sprint 9 for payment creation). Real provider integration
  (Sprint 9) upgrades the verification mechanism without requiring changes to Sprint 3 or Sprint 6.
- **§26 MFA**: primitive (Sprint 2) precedes and is called by all three of its consumers (Sprint 4,
  Sprint 6, Sprint 15).

The Medium-severity §19 pricing gap and Low-severity §28 retention gap are also resolved (Sprint 3
and Sprints 18/20, respectively). No duplicate primary scope exists anywhere in the 20 sprints,
confirmed on re-run. The one remaining open item (Notifications sequencing, Sprint 17) is assessed
as non-blocking for the reasons given in Sequencing risk 1 — it is a documentation-clarity
recommendation, not a structural conflict: no sprint's stated requirement is currently
unsatisfiable, unlike the resolved §17/§26 conflicts where "require elevated authentication" and
"require full verification" had no implementable meaning until this repair pass gave them one.

**Final status: READY TO BEGIN SPRINT 1**

No sprint functionality (application code) was implemented in this session — only the sprint-plan
documents listed above.
