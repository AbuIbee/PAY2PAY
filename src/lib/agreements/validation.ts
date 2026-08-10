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

export const createAgreementSchema = draftTermsSchema.extend({
  creditor: profileRefSchema,
  debtor: profileRefSchema,
  currency: z.string().length(3).optional(),
});
