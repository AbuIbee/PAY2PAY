"use client";

import { useId } from "react";
import { feeAllocationLabel } from "@/lib/ui/statusLabels";
import { todayLocalIsoDate } from "@/lib/ui/date";

export interface AgreementTermsFormValues {
  category: string;
  description: string;
  originalAmountMinorUnits: number;
  previousPaymentsMinorUnits: number;
  firstPaymentMinorUnits: number;
  installmentAmountMinorUnits: number;
  frequency: "weekly" | "biweekly" | "monthly";
  firstPaymentDate: string;
  feeAllocation: "creditor_pays" | "debtor_pays" | "split_evenly";
  earlyPayoffTerms: string;
  hardshipRules: string;
  partialPaymentRules: string;
  settlementRules: string;
  disputeProcedure: string;
}

export const BLANK_AGREEMENT_TERMS: AgreementTermsFormValues = {
  category: "",
  description: "",
  originalAmountMinorUnits: 0,
  previousPaymentsMinorUnits: 0,
  firstPaymentMinorUnits: 0,
  installmentAmountMinorUnits: 0,
  frequency: "monthly",
  firstPaymentDate: "",
  feeAllocation: "split_evenly",
  earlyPayoffTerms: "",
  hardshipRules: "",
  partialPaymentRules: "",
  settlementRules: "",
  disputeProcedure: "",
};

/**
 * Dollars-and-cents input over an integer-minor-units value — never lets the caller hold a float
 * minor-unit value. `required` defaults to true (most of these fields are server-validated as
 * positive, so blocking an empty submission client-side is correct); pass `required={false}` for a
 * field the backend allows to be zero (e.g. "previous payments already made" on a brand-new
 * agreement) — otherwise a deliberately-entered "0" immediately redisplays as an empty string (see
 * the value ternary below) and the field's own `required` attribute becomes permanently
 * unsatisfiable, silently blocking submission for the single most common real value of that field.
 */
function DollarField({
  id,
  label,
  minorUnits,
  onChange,
  required = true,
}: {
  id: string;
  label: string;
  minorUnits: number;
  onChange: (minorUnits: number) => void;
  required?: boolean;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={0}
        step="0.01"
        value={minorUnits === 0 ? "" : (minorUnits / 100).toFixed(2)}
        onChange={(event) => {
          const dollars = Number(event.target.value);
          onChange(Number.isFinite(dollars) ? Math.round(dollars * 100) : 0);
        }}
        required={required}
      />
    </div>
  );
}

/**
 * Sprint 5's required agreement-terms fields (docs/sprints/SPRINT_05_Agreement_Engine.md), shared
 * between the create-draft form and the creditor's counterproposal form so the two never drift
 * apart. Money fields are entered in dollars and converted to integer minor units here — the caller
 * (AgreementService, via the API route) only ever sees integers (FR-MONEY-001).
 */
export function AgreementTermsFields({
  values,
  onChange,
}: {
  values: AgreementTermsFormValues;
  onChange: (patch: Partial<AgreementTermsFormValues>) => void;
}) {
  const idPrefix = useId();

  return (
    <>
      <div className="early-access-form__row">
        <div className="field">
          <label htmlFor={`${idPrefix}-category`}>Category</label>
          <input
            id={`${idPrefix}-category`}
            value={values.category}
            onChange={(event) => onChange({ category: event.target.value })}
            placeholder="e.g. personal_loan, repair_service"
            required
            maxLength={200}
          />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-frequency`}>How often will payments be made?</label>
          <select
            id={`${idPrefix}-frequency`}
            value={values.frequency}
            onChange={(event) => onChange({ frequency: event.target.value as AgreementTermsFormValues["frequency"] })}
          >
            <option value="weekly">Weekly</option>
            <option value="biweekly">Every two weeks</option>
            <option value="monthly">Monthly</option>
          </select>
        </div>
      </div>

      <div className="field">
        <label htmlFor={`${idPrefix}-description`}>What is this repayment for?</label>
        <textarea
          id={`${idPrefix}-description`}
          value={values.description}
          onChange={(event) => onChange({ description: event.target.value })}
          placeholder="Example: Repayment of $1,200 borrowed for automobile repairs"
          required
          maxLength={5000}
        />
        <small>This appears on the agreement both parties sign.</small>
      </div>

      <div className="early-access-form__row">
        <DollarField
          id={`${idPrefix}-original`}
          label="Original amount"
          minorUnits={values.originalAmountMinorUnits}
          onChange={(originalAmountMinorUnits) => onChange({ originalAmountMinorUnits })}
        />
        <DollarField
          id={`${idPrefix}-previous`}
          label="Previous payments already made"
          minorUnits={values.previousPaymentsMinorUnits}
          onChange={(previousPaymentsMinorUnits) => onChange({ previousPaymentsMinorUnits })}
          required={false}
        />
      </div>

      <div className="early-access-form__row">
        <DollarField
          id={`${idPrefix}-first-payment`}
          label="First payment amount"
          minorUnits={values.firstPaymentMinorUnits}
          onChange={(firstPaymentMinorUnits) => onChange({ firstPaymentMinorUnits })}
        />
        <div className="field">
          <label htmlFor={`${idPrefix}-first-date`}>First payment date</label>
          <input
            id={`${idPrefix}-first-date`}
            type="date"
            value={values.firstPaymentDate}
            min={todayLocalIsoDate()}
            onChange={(event) => onChange({ firstPaymentDate: event.target.value })}
            required
          />
          {values.firstPaymentDate && values.firstPaymentDate < todayLocalIsoDate() && (
            <p className="field-error" role="alert">
              First payment date cannot be in the past.
            </p>
          )}
        </div>
      </div>

      <div className="early-access-form__row">
        <DollarField
          id={`${idPrefix}-installment`}
          label="Recurring installment amount"
          minorUnits={values.installmentAmountMinorUnits}
          onChange={(installmentAmountMinorUnits) => onChange({ installmentAmountMinorUnits })}
        />
        <div className="field">
          <label htmlFor={`${idPrefix}-fee`}>Who pays any processing fee?</label>
          <select
            id={`${idPrefix}-fee`}
            value={values.feeAllocation}
            onChange={(event) => onChange({ feeAllocation: event.target.value as AgreementTermsFormValues["feeAllocation"] })}
          >
            <option value="creditor_pays">{feeAllocationLabel("creditor_pays")}</option>
            <option value="debtor_pays">{feeAllocationLabel("debtor_pays")}</option>
            <option value="split_evenly">{feeAllocationLabel("split_evenly")}</option>
          </select>
        </div>
      </div>

      <div className="field">
        <label htmlFor={`${idPrefix}-early-payoff`}>What happens if this is paid off early?</label>
        <textarea
          id={`${idPrefix}-early-payoff`}
          value={values.earlyPayoffTerms}
          onChange={(event) => onChange({ earlyPayoffTerms: event.target.value })}
          placeholder="Example: The remaining balance may be paid at any time with no penalty."
          required
          maxLength={2000}
        />
        <small>Explain any discount, fee, or restriction on paying the balance ahead of schedule.</small>
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-hardship`}>What happens if a payment can&apos;t be made on time?</label>
        <textarea
          id={`${idPrefix}-hardship`}
          value={values.hardshipRules}
          onChange={(event) => onChange({ hardshipRules: event.target.value })}
          placeholder="Example: The payer will notify the other party as soon as possible and both parties will agree on a revised date."
          required
          maxLength={2000}
        />
        <small>Describe how a missed or late payment will be handled.</small>
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-partial`}>Are partial payments allowed?</label>
        <textarea
          id={`${idPrefix}-partial`}
          value={values.partialPaymentRules}
          onChange={(event) => onChange({ partialPaymentRules: event.target.value })}
          placeholder="Example: Partial payments are accepted and will be applied to the current installment."
          required
          maxLength={2000}
        />
        <small>Explain whether paying less than the scheduled installment is acceptable.</small>
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-settlement`}>Can this agreement be settled for less than the full balance?</label>
        <textarea
          id={`${idPrefix}-settlement`}
          value={values.settlementRules}
          onChange={(event) => onChange({ settlementRules: event.target.value })}
          placeholder="Example: Either party may propose a lump-sum settlement, which must be accepted in writing by the other party."
          required
          maxLength={2000}
        />
        <small>Explain whether and how a reduced payoff amount can be agreed to.</small>
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-dispute`}>How will disagreements be handled?</label>
        <textarea
          id={`${idPrefix}-dispute`}
          value={values.disputeProcedure}
          onChange={(event) => onChange({ disputeProcedure: event.target.value })}
          placeholder="Example: Both parties will attempt to resolve any disagreement directly before using the in-app dispute process."
          required
          maxLength={2000}
        />
        <small>Describe the steps both parties will take if they disagree about a payment or term.</small>
      </div>
    </>
  );
}
