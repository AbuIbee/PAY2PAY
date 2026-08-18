import { ValidationError } from "@/lib/errors";

export type PaymentFrequency = "weekly" | "biweekly" | "monthly";

export interface ScheduleInput {
  /** The full remaining debt at agreement time (original amount minus previous payments), integer minor units. */
  currentPrincipalMinorUnits: number;
  /** Any amount mutually agreed upon — need not equal the recurring installment (master spec §5). */
  firstPaymentMinorUnits: number;
  /** The recurring installment amount; the schedule's length is derived from this, not typed directly (master spec §10). */
  installmentAmountMinorUnits: number;
  frequency: PaymentFrequency;
  /** ISO date (YYYY-MM-DD) the first payment is due. */
  firstPaymentDate: string;
}

export interface ScheduleItem {
  /** 0 = first payment; 1..N = later installments, in order. */
  sequenceNumber: number;
  dueDate: string; // ISO date (YYYY-MM-DD)
  amountMinorUnits: number;
}

export interface ComputedSchedule {
  items: ScheduleItem[];
  /** The last later-installment amount — may be uneven, absorbing the rounding remainder (FR-FPAY-002 AC2). */
  finalPaymentMinorUnits: number;
  /** Count of later installments, not including the first payment. */
  numberOfInstallments: number;
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDate(isoDate: string): { year: number; month: number; day: number } {
  if (!ISO_DATE_PATTERN.test(isoDate) || Number.isNaN(Date.parse(`${isoDate}T00:00:00Z`))) {
    throw new ValidationError("firstPaymentDate must be a valid ISO date (YYYY-MM-DD).");
  }
  const parts = isoDate.split("-").map(Number);
  return { year: parts[0] ?? 0, month: parts[1] ?? 0, day: parts[2] ?? 0 };
}

function formatIsoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Deterministic date math with no floating-point/timezone ambiguity — all arithmetic happens on
 * plain (year, month, day) integers via Date.UTC, never on a wall-clock `Date` read back with
 * local-timezone getters. Monthly addition clamps to the target month's actual last day (e.g. Jan
 * 31 + 1 month = Feb 28/29, never "rolls over" into March).
 */
export function addFrequencyInterval(isoDate: string, frequency: PaymentFrequency, multiplier: number): string {
  const { year, month, day } = parseIsoDate(isoDate);
  if (frequency === "weekly" || frequency === "biweekly") {
    const daysToAdd = (frequency === "weekly" ? 7 : 14) * multiplier;
    const base = Date.UTC(year, month - 1, day);
    const shifted = new Date(base + daysToAdd * 24 * 60 * 60 * 1000);
    return formatIsoDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
  }
  // monthly
  const targetMonthIndex = (month - 1) + multiplier;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12; // 0-based, always positive
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, daysInTargetMonth);
  return formatIsoDate(targetYear, targetMonth + 1, clampedDay);
}

/**
 * Sprint 5 (docs/sprints/SPRINT_05_Agreement_Engine.md) schedule calculation. Pure function — no
 * I/O, easily unit-testable in isolation from AgreementService. Integer minor units throughout
 * (FR-MONEY-001); the rounding remainder from dividing the post-first-payment balance across
 * `installmentAmountMinorUnits`-sized installments is absorbed entirely into the final installment
 * (FR-FPAY-002 AC2), never spread across installments or silently dropped.
 */
export function computeSchedule(input: ScheduleInput): ComputedSchedule {
  // PRSprint 17 (docs/prsprints/PRSPRINT_17_PAYMENT_SCHEDULE_MONETARY_MATH.md): Number.isSafeInteger
  // (not merely Number.isInteger) — a value like 2**53 is technically an integer per Number.isInteger
  // but cannot be represented exactly, which would let unsafe arithmetic silently corrupt a schedule.
  // No master-spec-stated dollar minimum/maximum exists (checked docs/PAY2PAY_MASTER_SPEC.md — no
  // match), so this is the one defensible bound: not a business rule, purely "this number can be
  // trusted to add/subtract/compare exactly," which is the actual Hard Stop rule's concern.
  if (!Number.isSafeInteger(input.currentPrincipalMinorUnits) || input.currentPrincipalMinorUnits < 0) {
    throw new ValidationError("currentPrincipalMinorUnits must be a non-negative integer.");
  }
  if (!Number.isSafeInteger(input.firstPaymentMinorUnits) || input.firstPaymentMinorUnits < 0) {
    throw new ValidationError("firstPaymentMinorUnits must be a non-negative integer.");
  }
  if (input.firstPaymentMinorUnits > input.currentPrincipalMinorUnits) {
    throw new ValidationError("firstPaymentMinorUnits cannot exceed currentPrincipalMinorUnits.");
  }

  const remainingAfterFirstPayment = input.currentPrincipalMinorUnits - input.firstPaymentMinorUnits;
  const firstItem: ScheduleItem = {
    sequenceNumber: 0,
    dueDate: input.firstPaymentDate,
    amountMinorUnits: input.firstPaymentMinorUnits,
  };

  if (remainingAfterFirstPayment === 0) {
    // The first payment alone clears the debt — no later installments.
    return { items: [firstItem], finalPaymentMinorUnits: input.firstPaymentMinorUnits, numberOfInstallments: 0 };
  }

  if (!Number.isSafeInteger(input.installmentAmountMinorUnits) || input.installmentAmountMinorUnits <= 0) {
    throw new ValidationError("installmentAmountMinorUnits must be a positive integer.");
  }

  const numberOfInstallments = Math.ceil(remainingAfterFirstPayment / input.installmentAmountMinorUnits);
  const items: ScheduleItem[] = [firstItem];
  for (let sequenceNumber = 1; sequenceNumber < numberOfInstallments; sequenceNumber += 1) {
    items.push({
      sequenceNumber,
      dueDate: addFrequencyInterval(input.firstPaymentDate, input.frequency, sequenceNumber),
      amountMinorUnits: input.installmentAmountMinorUnits,
    });
  }
  const finalPaymentMinorUnits =
    remainingAfterFirstPayment - input.installmentAmountMinorUnits * (numberOfInstallments - 1);
  items.push({
    sequenceNumber: numberOfInstallments,
    dueDate: addFrequencyInterval(input.firstPaymentDate, input.frequency, numberOfInstallments),
    amountMinorUnits: finalPaymentMinorUnits,
  });

  return { items, finalPaymentMinorUnits, numberOfInstallments };
}
