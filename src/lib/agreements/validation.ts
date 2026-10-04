import { z } from "zod";

/** Shared zod schemas for the /api/agreements/* routes — kept in one place so the create and
 * counter-proposal routes (which accept the same term fields) don't drift apart. */

export const profileRefSchema = z.object({ kind: z.enum(["personal", "business"]), id: z.string().uuid() });

export const draftTermsSchema = z.object({
  category: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(5000),
  originalAmountMinorUnits: z.number().int().positive(),
  previousPaymentsMinorUnits: z.number().int().nonnegative(),
  firstPaymentMinorUnits: z.number().int().nonnegative(),
  installmentAmountMinorUnits: z.number().int().nonnegative(),
  frequency: z.enum(["weekly", "biweekly", "monthly"]),
  firstPaymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  feeAllocation: z.enum(["creditor_pays", "debtor_pays", "split_evenly"]),
  earlyPayoffTerms: z.string().trim().min(1).max(2000),
  hardshipRules: z.string().trim().min(1).max(2000),
  partialPaymentRules: z.string().trim().min(1).max(2000),
  settlementRules: z.string().trim().min(1).max(2000),
  disputeProcedure: z.string().trim().min(1).max(2000),
  supportingEvidenceReferences: z.array(z.string().trim().min(1)).optional(),
});

/**
 * "PAID2YOU — B2B IDENTITY / ORGANIZATION / SUBSCRIPTION ARCHITECTURE", Phase 9 (2026-10-02): an
 * UNTRUSTED intent signal only — "the caller is asking to create this agreement in the context of
 * workspace X," never itself the authorization for X. AgreementWorkspaceService.createDraftForWorkspace
 * re-derives and validates membership/capability/entitlement server-side before any organizationId is
 * ever persisted; this schema's only job is to accept the shape and reject anything else. Omitting
 * `workspace` entirely defaults to personal (see the route handler) — the existence of this field is
 * never itself sufficient to create an organization-scoped agreement.
 */
export const workspaceSelectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("personal") }),
  z.object({ kind: z.literal("organization"), organizationId: z.string().uuid() }),
]);

export const createAgreementSchema = draftTermsSchema.extend({
  creditor: profileRefSchema,
  debtor: profileRefSchema,
  currency: z.string().length(3).optional(),
  workspace: workspaceSelectorSchema.optional(),
});
