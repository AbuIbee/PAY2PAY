"use client";

import { useState } from "react";

interface PasswordFieldProps {
  id: string;
  name: string;
  label: string;
  autoComplete: "current-password" | "new-password";
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  helperText?: string;
}

/**
 * Section J (closed-beta remediation, Product Owner review): a standard show/hide control for every
 * password-entry screen (LoginForm, SignupForm, ResetPasswordForm previously each had a plain, always-
 * masked `<input type="password">` with no way to check what was typed). Default is masked; toggling
 * only flips the input's `type` between "password"/"text" client-side — the value itself is never
 * logged or sent anywhere by this component.
 */
export function PasswordField({ id, name, label, autoComplete, required, minLength, maxLength, helperText }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "stretch" }}>
        <input
          id={id}
          name={name}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          required={required}
          minLength={minLength}
          maxLength={maxLength}
          style={{ flex: 1 }}
        />
        <button
          type="button"
          className="button button--ghost"
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
        >
          {visible ? "Hide" : "Show"}
        </button>
      </div>
      {helperText ? <small>{helperText}</small> : null}
    </div>
  );
}
