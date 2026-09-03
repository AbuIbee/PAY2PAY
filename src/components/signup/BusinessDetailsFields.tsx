"use client";

import { useId } from "react";

export interface BusinessAddressState {
  line1: string;
  line2: string;
  city: string;
  postalCode: string;
}

export interface BusinessDetailsState {
  legalBusinessName: string;
  dbaName: string;
  entityType: string;
  businessPhone: string;
  businessAddress: BusinessAddressState;
  state: string;
  country: string;
  taxIdType: "" | "EIN" | "SSN" | "ITIN";
}

export const BLANK_BUSINESS_DETAILS: BusinessDetailsState = {
  legalBusinessName: "",
  dbaName: "",
  entityType: "",
  businessPhone: "",
  businessAddress: { line1: "", line2: "", city: "", postalCode: "" },
  state: "",
  country: "US",
  taxIdType: "",
};

function Req() {
  return (
    <span aria-hidden="true" style={{ color: "var(--ink-soft)" }}>
      {" "}
      *
    </span>
  );
}

interface BusinessDetailsFieldsProps {
  value: BusinessDetailsState;
  onChange: (value: BusinessDetailsState) => void;
}

/**
 * Business signup's own fields, on top of PersonalIdentityFields (the authorized representative).
 * Deliberately collects only the tax-ID *type*, never the number itself — no compliant provider-hosted
 * tokenization exists yet in this codebase (see docs/OPEN_ISSUES.md and BusinessSignupDetails's own
 * doc comment in authService.ts). Full tax-ID verification will run through a secure provider later;
 * this form never asks for, and PAY2PAY's backend never accepts, the number.
 */
export function BusinessDetailsFields({ value, onChange }: BusinessDetailsFieldsProps) {
  const formId = useId();

  function setField<K extends keyof BusinessDetailsState>(key: K, fieldValue: BusinessDetailsState[K]) {
    onChange({ ...value, [key]: fieldValue });
  }

  function setAddressField<K extends keyof BusinessAddressState>(key: K, fieldValue: BusinessAddressState[K]) {
    onChange({ ...value, businessAddress: { ...value.businessAddress, [key]: fieldValue } });
  }

  return (
    <fieldset style={{ border: "none", padding: 0, margin: 0, display: "grid", gap: "1rem" }}>
      <legend style={{ fontWeight: 600, padding: 0, marginBottom: "0.25rem" }}>Business</legend>

      <div className="field">
        <label htmlFor={`${formId}-legal-name`}>
          Legal business name
          <Req />
        </label>
        <input
          id={`${formId}-legal-name`}
          required
          value={value.legalBusinessName}
          onChange={(event) => setField("legalBusinessName", event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`${formId}-dba-name`}>DBA/trade name (optional)</label>
        <input id={`${formId}-dba-name`} value={value.dbaName} onChange={(event) => setField("dbaName", event.target.value)} />
        <small>Shown to counterparties instead of the legal name, if given. Defaults to the legal name.</small>
      </div>
      <div className="field">
        <label htmlFor={`${formId}-entity-type`}>
          Business/entity type
          <Req />
        </label>
        <input
          id={`${formId}-entity-type`}
          required
          placeholder="e.g. LLC, Corporation, Sole proprietorship"
          value={value.entityType}
          onChange={(event) => setField("entityType", event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`${formId}-business-phone`}>Business phone (optional)</label>
        <input
          id={`${formId}-business-phone`}
          type="tel"
          value={value.businessPhone}
          onChange={(event) => setField("businessPhone", event.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor={`${formId}-line1`}>
          Business address line 1
          <Req />
        </label>
        <input
          id={`${formId}-line1`}
          required
          value={value.businessAddress.line1}
          onChange={(event) => setAddressField("line1", event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`${formId}-line2`}>Address line 2 (optional)</label>
        <input
          id={`${formId}-line2`}
          value={value.businessAddress.line2}
          onChange={(event) => setAddressField("line2", event.target.value)}
        />
      </div>
      <div className="early-access-form__row">
        <div className="field">
          <label htmlFor={`${formId}-city`}>
            City
            <Req />
          </label>
          <input
            id={`${formId}-city`}
            required
            value={value.businessAddress.city}
            onChange={(event) => setAddressField("city", event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${formId}-state`}>
            State/province
            <Req />
          </label>
          <input id={`${formId}-state`} required value={value.state} onChange={(event) => setField("state", event.target.value)} />
        </div>
      </div>
      <div className="early-access-form__row">
        <div className="field">
          <label htmlFor={`${formId}-postal-code`}>
            ZIP/postal code
            <Req />
          </label>
          <input
            id={`${formId}-postal-code`}
            required
            value={value.businessAddress.postalCode}
            onChange={(event) => setAddressField("postalCode", event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${formId}-country`}>
            Country
            <Req />
          </label>
          <input id={`${formId}-country`} required value={value.country} onChange={(event) => setField("country", event.target.value)} />
        </div>
      </div>

      <div className="field">
        <label htmlFor={`${formId}-tax-id-type`}>
          Business tax-ID type
          <Req />
        </label>
        <select
          id={`${formId}-tax-id-type`}
          required
          value={value.taxIdType}
          onChange={(event) => setField("taxIdType", event.target.value as BusinessDetailsState["taxIdType"])}
        >
          <option value="">Select…</option>
          <option value="EIN">EIN</option>
          <option value="SSN">SSN</option>
          <option value="ITIN">ITIN</option>
        </select>
        <small>
          Business tax-ID verification is required and will be completed through a secure verification provider after signup. Your
          tax-ID number itself is never collected or stored here.
        </small>
      </div>
    </fieldset>
  );
}
