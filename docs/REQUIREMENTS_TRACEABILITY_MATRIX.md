# Requirements Traceability Matrix

Maps every numbered section of `docs/PAY2PAY_MASTER_SPEC.md` (Sections 1–37, including 18A) to the
project document(s) and specific requirement ID(s) that implement it. Built by re-reading the
master spec section by section and cross-checking against every deliverable produced. Where a
section is only partially closed (an open decision remains), that is noted in the Gap column rather
than left implicit.

| Spec § | Title | Implementing document(s) | Requirement/artifact ID(s) | Gap (if any) |
|---|---|---|---|---|
| 1 | Product concept | `docs/deliverables/01-executive-summary.md`; `docs/DATA_MODEL.md` §4 (country/currency/timezone/locale fields); `docs/deliverables/05-nonfunctional-requirements.md` | NFR-PERF-001 (device matrix) | None |
| 2 | Ethical and Islamic-finance positioning | `docs/deliverables/01-executive-summary.md`; `docs/deliverables/04-functional-requirements.md`; `docs/COMPLIANCE_REVIEW_CHECKLIST.md` | FR-AGR-002 (AC2), FR-HARD-004, FR-B2B-008; Compliance S1–S7 | Open decision #1; Sharia review not yet performed |
| 3 | Agreement-creation principles | `docs/deliverables/03-user-journeys.md` (Journeys 1, 3, 4); `docs/deliverables/04-functional-requirements.md`; `docs/STATE_MACHINES.md` §1 | FR-AGR-001–008 | None |
| 4 | Required agreement information | `docs/deliverables/04-functional-requirements.md`; `docs/DATA_MODEL.md` §4 (`agreement_version.terms`) | FR-AGR-002 | None |
| 5 | Mandatory first payment | `docs/deliverables/03-user-journeys.md` (Journey 5); `docs/deliverables/04-functional-requirements.md`; `docs/STATE_MACHINES.md` §1 | FR-FPAY-001–004 | None |
| 6 | Payment methods | `docs/PAYMENT_ARCHITECTURE.md` §1–2; `docs/deliverables/04-functional-requirements.md` | FR-PAYMETHOD-001–004 | Open decision #3 (no processor confirmed) |
| 7 | Payment routing and payouts | `docs/PAYMENT_ARCHITECTURE.md` §3, §5; `docs/PAYMENT_STATE_MACHINE.md` §2 | FR-ROUTE-001–003 | None |
| 8 | Failed-payment workflow | `docs/deliverables/03-user-journeys.md` (Journeys 6–7); `docs/PAYMENT_ARCHITECTURE.md` §6; `docs/PAYMENT_STATE_MACHINE.md` §1 | FR-FAIL-001–006 | None |
| 9 | Hardship workflow | `docs/deliverables/03-user-journeys.md` (Journey 8); `docs/STATE_MACHINES.md` §4 | FR-HARD-001–004 | None |
| 10 | Early payments | `docs/deliverables/03-user-journeys.md` (Journeys 10–11); `docs/STATE_MACHINES.md` §1 | FR-EARLY-001–003 | None |
| 11 | Partial payments | `docs/deliverables/03-user-journeys.md` (Journey 9); `docs/STATE_MACHINES.md` §5 | FR-PART-001–004 | None |
| 12 | Settlements | `docs/deliverables/03-user-journeys.md` (Journey 12); `docs/STATE_MACHINES.md` §6 | FR-SETL-001–004 | None |
| 13 | Disputes | `docs/deliverables/03-user-journeys.md` (Journey 13); `docs/STATE_MACHINES.md` §7 | FR-DISP-001–006 | None |
| 14 | Unauthorized-payment disputes | `docs/deliverables/03-user-journeys.md` (Journey 14); `docs/PAYMENT_STATE_MACHINE.md` §3 | FR-UPAY-001–006 | None |
| 15 | Evidence and documents | `docs/ARCHITECTURE.md` §7; `docs/deliverables/04-functional-requirements.md` | FR-EVID-001–005 | None |
| 16 | Witnesses | `docs/deliverables/02-roles-permissions-matrix.md`; `docs/deliverables/03-user-journeys.md` (Journey 15); `docs/STATE_MACHINES.md` §13 | FR-WIT-001–004 | Open decision #9/#18 (verification tier assumption) |
| 17 | Identity verification | `docs/deliverables/02-roles-permissions-matrix.md` §2; `docs/STATE_MACHINES.md` §8–9 | FR-IDV-001–004 | Open decision #16 (no provider named) |
| 18 | Personal and business profiles | `docs/deliverables/02-roles-permissions-matrix.md` §1; `docs/DATA_MODEL.md` §2–3 | FR-PROF-001–004 | None |
| 18A | Business-to-business requirements | `docs/ARCHITECTURE.md` §0; `docs/DATA_MODEL.md` (`business_staff_member.is_authorized_representative`, `staff_approval_request`) | FR-B2B-001–010 | None |
| 19 | Pricing logic | `docs/deliverables/04-functional-requirements.md`; `docs/DATA_MODEL.md` §1 (`pricing_plan`, `pricing_tier`, `subscription`) | FR-PRICE-001–006 | Open decision #4 (B2B dual-pricing default) |
| 20 | Business staff and permissions | `docs/deliverables/02-roles-permissions-matrix.md` §3–4; `docs/DATA_MODEL.md` §4 | FR-STAFF-001–005 | Open decisions #5–8 (role-boundary specifics) |
| 21 | Bulk imports and integrations | `docs/deliverables/03-user-journeys.md` (Journey 16); `docs/ARCHITECTURE.md` §6 | FR-CSV-001–004 | None |
| 22 | Invitations | `docs/DATA_MODEL.md` §4 (`invitation`, `invitation_event`); `docs/STATE_MACHINES.md` §12 | FR-INV-001–004 | None |
| 23 | Notifications | `docs/ARCHITECTURE.md` §8 | FR-NOTIF-001–004 | None |
| 24 | Internal communication | `docs/deliverables/04-functional-requirements.md` | FR-COMM-001–002 | None |
| 25 | Credit reporting | `docs/deliverables/04-functional-requirements.md` | FR-CREDIT-001–002 | None |
| 26 | Multifactor authentication | `docs/ARCHITECTURE.md` §3; `docs/deliverables/04-functional-requirements.md` | FR-MFA-001–002 | None |
| 27 | Electronic signatures | `docs/DATA_MODEL.md` §4 (`signature_event`); `docs/ARCHITECTURE.md` §7 | FR-SIG-001–003 | None |
| 28 | Data retention | `docs/DATA_MODEL.md` §7–8 | FR-RET-001–003; NFR-RET-001–002 | Open decision #15 (backup-lifecycle reconciliation) |
| 29 | Administration | `docs/deliverables/02-roles-permissions-matrix.md` (Platform administrator) | FR-ADMIN-001–003 | None |
| 30 | Appeals | `docs/deliverables/03-user-journeys.md` (Journey 19); `docs/STATE_MACHINES.md` §10 | FR-APPEAL-001–003 | Open decision #5 (compliance-reviewer authority) |
| 31 | Fraud and risk management | `docs/SECURITY_MODEL.md`; `docs/ARCHITECTURE.md` §2 (Fraud & Risk Service) | FR-FRAUD-001–004 | None |
| 32 | Administrative and audit integrity | `docs/DATA_MODEL.md` §6 | FR-AUDIT-001–003; NFR-AUDIT-001–002 | None |
| 33 | Technical expectations | `docs/ARCHITECTURE.md` (entire document); `docs/deliverables/05-nonfunctional-requirements.md` | NFR-SEC-*, NFR-PERF-*, NFR-REL-*, NFR-SCALE-* | Open decisions #11–15 (numeric targets) |
| 34 | Accessibility and user experience | `docs/deliverables/05-nonfunctional-requirements.md` §Accessibility | NFR-ACC-001–005 | None |
| 35 | MVP boundaries | `docs/deliverables/01-executive-summary.md` (MVP Boundaries) | — | None |
| 36 | Required deliverables | `docs/PROGRESS.md` (this entire project) | Deliverables 1–15 | None |
| 37 | Critical working rules | `docs/PAYMENT_ARCHITECTURE.md` §11; `docs/COMPLIANCE_REVIEW_CHECKLIST.md` (disclaimer); all documents' "no code/migrations" discipline | FR-MONEY-001–003 | None |

## Notes on this matrix's construction

- **"Implementing document(s)"** lists where the requirement is *specified*, not where it is
  *built* — no application code exists yet (`docs/IMPLEMENTATION_PLAN.md` tracks the build-out).
- **Cross-cutting sections** (33, 36, 37) map to broad swaths of the documentation set rather than
  a single file, since they describe platform-wide properties or the deliverable process itself
  rather than a bounded feature.
- **Gap column** entries are all already-tracked items in `docs/OPEN_DECISIONS.md` — this matrix
  does not introduce any new gap, it cross-references existing ones against their originating spec
  section for auditability.
- Every row was checked against the actual current file content (not assumed from memory) as part
  of this traceability pass; no spec section was found to be entirely unaddressed.

---

**Coverage note:** All 38 numbered items in the master spec (Sections 1–35, 18A, 36, 37) are
accounted for above. This satisfies the user's explicit instruction that the matrix "map every
numbered section of the master specification to the document and requirement that implements it."
