"use client";

import { useId } from "react";

export interface SignupAddressState {
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface PersonalIdentityState {
  firstName: string;
  middleName: string;
  lastName: string;
  contactPhone: string;
  address: SignupAddressState;
}

export const BLANK_SIGNUP_ADDRESS: SignupAddressState = { line1: "", line2: "", city: "", state: "", postalCode: "", country: "US" };
export const BLANK_PERSONAL_IDENTITY: PersonalIdentityState = {
  firstName: "",
  middleName: "",
  lastName: "",
  contactPhone: "",
  address: BLANK_SIGNUP_ADDRESS,
};

function Req() {
  return (
    <span aria-hidden="true" style={{ color: "var(--ink-soft)" }}>
      {" "}
      *
    </span>
  );
}

interface PersonalIdentityFieldsProps {
  value: PersonalIdentityState;
  onChange: (value: PersonalIdentityState) => void;
  /** Business signup collects this same block for the authorized representative, not the signer themselves as a private individual — swaps the heading/copy without duplicating the fields. */
  legend?: string;
}

/**
 * Shared by both Personal signup and Business signup's authorized-representative section — collects
 * exactly REQUIRED_PROFILE_FIELDS (personalProfileService.ts) plus the optional middle name, so a
 * brand-new account normally satisfies checkAgreementParticipationReadiness() immediately (pending only
 * email verification, which the just-sent verification link covers).
 */
export function PersonalIdentityFields({ value, onChange, legend }: PersonalIdentityFieldsProps) {
  const formId = useId();

  function setField<K extends keyof PersonalIdentityState>(key: K, fieldValue: PersonalIdentityState[K]) {
    onChange({ ...value, [key]: fieldValue });
  }

  function setAddressField<K extends keyof SignupAddressState>(key: K, fieldValue: SignupAddressState[K]) {
    onChange({ ...value, address: { ...value.address, [key]: fieldValue } });
  }

  return (
    <fieldset style={{ border: "none", padding: 0, margin: 0, display: "grid", gap: "1rem" }}>
      {legend ? <legend style={{ fontWeight: 600, padding: 0, marginBottom: "0.25rem" }}>{legend}</legend> : null}

      <div className="early-access-form__row">
        <div className="field">
          <label htmlFor={`${formId}-first-name`}>
            First name
            <Req />
          </label>
          <input
            id={`${formId}-first-name`}
            required
            value={value.firstName}
            onChange={(event) => setField("firstName", event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${formId}-middle-name`}>Middle name (optional)</label>
          <input
            id={`${formId}-middle-name`}
            value={value.middleName}
            onChange={(event) => setField("middleName", event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${formId}-last-name`}>
            Last name
            <Req />
          </label>
          <input
            id={`${formId}-last-name`}
            required
            value={value.lastName}
            onChange={(event) => setField("lastName", event.target.value)}
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor={`${formId}-contact-phone`}>
          Contact/mobile phone
          <Req />
        </label>
        <input
          id={`${formId}-contact-phone`}
          type="tel"
          required
          value={value.contactPhone}
          onChange={(event) => setField("contactPhone", event.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor={`${formId}-line1`}>
          Residential address line 1
          <Req />
        </label>
        <input id={`${formId}-line1`} required value={value.address.line1} onChange={(event) => setAddressField("line1", event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`${formId}-line2`}>Address line 2 (optional)</label>
        <input id={`${formId}-line2`} value={value.address.line2} onChange={(event) => setAddressField("line2", event.target.value)} />
      </div>
      <div className="early-access-form__row">
        <div className="field">
          <label htmlFor={`${formId}-city`}>
            City
            <Req />
          </label>
          <input id={`${formId}-city`} required value={value.address.city} onChange={(event) => setAddressField("city", event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${formId}-state`}>
            State/province
            <Req />
          </label>
          <input id={`${formId}-state`} required value={value.address.state} onChange={(event) => setAddressField("state", event.target.value)} />
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
            value={value.address.postalCode}
            onChange={(event) => setAddressField("postalCode", event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${formId}-country`}>
            Country
            <Req />
          </label>
          <input
            id={`${formId}-country`}
            required
            value={value.address.country}
            onChange={(event) => setAddressField("country", event.target.value)}
          />
        </div>
      </div>
    </fieldset>
  );
}
