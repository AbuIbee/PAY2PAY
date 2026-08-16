import { z } from "zod";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";

/** Shared by the create and propose routes — see route.ts's own doc comment for why the boilerplate legal-text fields are optional with a generic default. */
export const DEFAULT_TERMS_TEXT = "Standard terms apply. Details can be discussed and refined after acceptance.";

export const termsRequestSchema = z.object({
  category: z.string().trim().max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  originalAmountMinorUnits: z.number().int().positive(),
  previousPaymentsMinorUnits: z.number().int().min(0).optional(),
  firstPaymentMinorUnits: z.number().int().positive(),
  installmentAmountMinorUnits: z.number().int().positive(),
  frequency: z.enum(["weekly", "biweekly", "monthly"]),
  firstPaymentDate: z.string().trim(),
  feeAllocation: z.enum(["creditor_pays", "debtor_pays", "split_evenly"]),
  earlyPayoffTerms: z.string().trim().max(2000).optional(),
  hardshipRules: z.string().trim().max(2000).optional(),
  partialPaymentRules: z.string().trim().max(2000).optional(),
  settlementRules: z.string().trim().max(2000).optional(),
  disputeProcedure: z.string().trim().max(2000).optional(),
  supportingEvidenceReferences: z.array(z.string()).optional(),
});

export type TermsRequestInput = z.infer<typeof termsRequestSchema>;

export function toDraftTermsInput(t: TermsRequestInput): DraftTermsInput {
  return {
    category: t.category?.trim() || "General",
    description: t.description?.trim() || DEFAULT_TERMS_TEXT,
    originalAmountMinorUnits: t.originalAmountMinorUnits,
    previousPaymentsMinorUnits: t.previousPaymentsMinorUnits ?? 0,
    firstPaymentMinorUnits: t.firstPaymentMinorUnits,
    installmentAmountMinorUnits: t.installmentAmountMinorUnits,
    frequency: t.frequency,
    firstPaymentDate: t.firstPaymentDate,
    feeAllocation: t.feeAllocation,
    earlyPayoffTerms: t.earlyPayoffTerms?.trim() || DEFAULT_TERMS_TEXT,
    hardshipRules: t.hardshipRules?.trim() || DEFAULT_TERMS_TEXT,
    partialPaymentRules: t.partialPaymentRules?.trim() || DEFAULT_TERMS_TEXT,
    settlementRules: t.settlementRules?.trim() || DEFAULT_TERMS_TEXT,
    disputeProcedure: t.disputeProcedure?.trim() || DEFAULT_TERMS_TEXT,
    supportingEvidenceReferences: t.supportingEvidenceReferences,
  };
}
