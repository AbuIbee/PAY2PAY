import { z } from "zod";

/** Shared zod shape for a settlement's negotiable terms — master spec §12's required fields, reused by both the propose and decide (counter) routes. */
export const settlementTermsSchema = z.object({
  preSettlementBalanceMinorUnits: z.number().int().positive(),
  settlementAmountMinorUnits: z.number().int().positive(),
  forgivenAmountMinorUnits: z.number().int().nonnegative(),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  paymentMode: z.enum(["one_time", "scheduled"]),
  failureConsequence: z.enum(["restore_original", "restore_stated", "forgive_permanently", "prior_agreement_controls"]),
  failureConsequenceStatedAmountMinorUnits: z.number().int().nonnegative().optional(),
});
