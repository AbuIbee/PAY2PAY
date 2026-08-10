"use client";

import { useId } from "react";

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

/** Dollars-and-cents input over an integer-minor-units value — never lets the caller hold a float minor-unit value. */
function DollarField({
  id,
  label,
  minorUnits,
  onChange,
}: {
  id: string;
  label: string;
  minorUnits: number;
  onChange: (minorUnits: number) => void;
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
        required
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
          <label htmlFor={`${idPrefix}-frequency`}>Installment frequency</label>
          <select
            id={`${idPrefix}-frequency`}
            value={values.frequency}
            onChange={(event) => onChange({ frequency: event.target.value as AgreementTermsFormValues["frequency"] })}
          >
            <option value="weekly">Weekly</option>
            <option value="biweekly">Biweekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </div>
      </div>

      <div className="field">
        <label htmlFor={`${idPrefix}-description`}>Description</label>
        <textarea
          id={`${idPrefix}-description`}
          value={values.description}
          onChange={(event) => onChange({ description: event.target.value })}
          required
          maxLength={5000}
        />
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
            onChange={(event) => onChange({ firstPaymentDate: event.target.value })}
            required
          />
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
          <label htmlFor={`${idPrefix}-fee`}>Processing-fee allocation</label>
          <select
            id={`${idPrefix}-fee`}
            value={values.feeAllocation}
            onChange={(event) => onChange({ feeAllocation: event.target.value as AgreementTermsFormValues["feeAllocation"] })}
          >
            <option value="creditor_pays">Creditor pays</option>
            <option value="debtor_pays">Debtor pays</option>
            <option value="split_evenly">Split evenly</option>
          </select>
        </div>
      </div>

      <div className="field">
        <label htmlFor={`${idPrefix}-early-payoff`}>Early payoff terms</label>
        <textarea
          id={`${idPrefix}-early-payoff`}
          value={values.earlyPayoffTerms}
          onChange={(event) => onChange({ earlyPayoffTerms: event.target.value })}
          required
          maxLength={2000}
        />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-hardship`}>Hardship rules</label>
        <textarea
          id={`${idPrefix}-hardship`}
          value={values.hardshipRules}
          onChange={(event) => onChange({ hardshipRules: event.target.value })}
          required
          maxLength={2000}
        />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-partial`}>Partial payment rules</label>
        <textarea
          id={`${idPrefix}-partial`}
          value={values.partialPaymentRules}
          onChange={(event) => onChange({ partialPaymentRules: event.target.value })}
          required
          maxLength={2000}
        />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-settlement`}>Settlement rules</label>
        <textarea
          id={`${idPrefix}-settlement`}
          value={values.settlementRules}
          onChange={(event) => onChange({ settlementRules: event.target.value })}
          required
          maxLength={2000}
        />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-dispute`}>Dispute procedure</label>
        <textarea
          id={`${idPrefix}-dispute`}
          value={values.disputeProcedure}
          onChange={(event) => onChange({ disputeProcedure: event.target.value })}
          required
          maxLength={2000}
        />
      </div>
    </>
  );
}
