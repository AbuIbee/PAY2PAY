"use client";

import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/ui/apiFetch";
import { todayLocalIsoDate } from "@/lib/ui/date";

type Frequency = "weekly" | "biweekly" | "monthly";
type Role = "creditor" | "debtor";

const FREQUENCY_LABEL: Record<Frequency, string> = { weekly: "Weekly", biweekly: "Every two weeks", monthly: "Monthly" };

type LoadState = "loading" | "ready" | "error";
type SubmitState = "idle" | "submitting" | "sent" | "error";

/**
 * PRSprint 10 (docs/prsprints/PRSPRINT_10_INVITATION_IDENTITY_CLAIMING_ACCEPTANCE.md): "Create
 * Agreement -> Enter Recipient -> Send Secure Link" — the sender-side half of the invitation
 * bridge. Deliberately separate from AgreementCreateWizard.tsx (which creates an agreement
 * directly between two *already-real* profiles) — this form's whole purpose is proposing terms to
 * someone who may not have a Paid2You account yet, so it never asks for a recipient profile id,
 * only a name/email/phone (see AgreementInvitationService.createInvitation's own doc comment for
 * why no real `agreement` row exists until the recipient accepts).
 */
export function InviteToAgreement() {
  const [state, setState] = useState<LoadState>("loading");
  const [actingProfile, setActingProfile] = useState<{ kind: "personal" | "business"; id: string; label: string } | null>(null);

  const [role, setRole] = useState<Role>("creditor");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [amount, setAmount] = useState("");
  const [installment, setInstallment] = useState("");
  const [frequency, setFrequency] = useState<Frequency>("weekly");
  const [firstPaymentDate, setFirstPaymentDate] = useState("");
  const [message, setMessage] = useState("");

  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const active = await apiFetch<{ kind: "personal" | "business"; personalProfileId?: string; businessProfileId?: string; displayName: string }>(
          "/api/profiles/active",
        );
        const id = active.kind === "business" ? active.businessProfileId : active.personalProfileId;
        if (!id) throw new Error("no active profile");
        setActingProfile({ kind: active.kind, id, label: active.displayName });
        setState("ready");
      } catch {
        setState("error");
      }
    })();
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!actingProfile) return;
    if (!recipientEmail.trim() && !recipientPhone.trim() && !recipientName.trim()) {
      setErrorMessage("Enter the recipient's name, email, or phone number.");
      return;
    }
    setSubmitState("submitting");
    setErrorMessage(null);
    try {
      const amountMinorUnits = Math.round(Number(amount) * 100);
      const installmentAmountMinorUnits = Math.round(Number(installment) * 100);
      const result = await apiFetch<{ link: string }>("/api/agreement-invitations", {
        method: "POST",
        body: JSON.stringify({
          inviterProfile: { kind: actingProfile.kind, id: actingProfile.id },
          inviterRole: role,
          recipientName: recipientName || undefined,
          recipientEmail: recipientEmail || undefined,
          recipientPhone: recipientPhone || undefined,
          message: message || undefined,
          terms: {
            originalAmountMinorUnits: amountMinorUnits,
            firstPaymentMinorUnits: installmentAmountMinorUnits,
            installmentAmountMinorUnits,
            frequency,
            firstPaymentDate,
            feeAllocation: "debtor_pays",
          },
        }),
      });
      setLink(result.link);
      setSubmitState("sent");
    } catch (error) {
      setErrorMessage(error instanceof ApiError ? error.message : "Couldn't send that invitation. Please try again.");
      setSubmitState("error");
    }
  }

  async function handleCopy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can fail — the link remains visible as text for manual copy.
    }
  }

  if (state === "loading") {
    return <div className="skeleton skeleton--card" aria-hidden="true" />;
  }
  if (state === "error" || !actingProfile) {
    return (
      <div className="form-status form-status--error" role="alert">
        Something went wrong loading your profile. Please try again.
      </div>
    );
  }

  if (submitState === "sent" && link) {
    return (
      <div className="early-access-form" style={{ display: "grid", gap: "1rem" }}>
        <h2 style={{ margin: 0 }}>Invitation sent</h2>
        <p style={{ margin: 0 }}>
          {recipientEmail || recipientPhone
            ? "We've sent a secure link. You can also share it directly:"
            : "Share this secure link with the recipient:"}
        </p>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
          <code style={{ wordBreak: "break-all", fontSize: "0.85rem" }}>{link}</code>
          <button type="button" className="button button--ghost" onClick={() => void handleCopy()}>
            {copied ? "Copied!" : "Copy link"}
          </button>
          {typeof navigator !== "undefined" && "share" in navigator && (
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void navigator.share({ title: "Payment plan proposal", url: link })}
            >
              Share…
            </button>
          )}
          <a
            className="button button--ghost"
            href={`https://wa.me/?text=${encodeURIComponent(`I've sent you a payment plan proposal on PAY2PAY: ${link}`)}`}
            target="_blank"
            rel="noreferrer"
          >
            Share on WhatsApp
          </a>
        </div>
        <p style={{ fontSize: "0.8rem", color: "var(--ink-soft)", margin: 0 }}>This link expires in 7 days and can only be used once.</p>
      </div>
    );
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="early-access-form" style={{ display: "grid", gap: "1rem" }}>
      <p style={{ margin: 0, color: "var(--ink-soft)" }}>Acting as: {actingProfile.label}</p>

      <div className="field">
        <label htmlFor="invite-role">Your role</label>
        <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="creditor">I&apos;m owed money (creditor)</option>
          <option value="debtor">I owe money (debtor)</option>
        </select>
      </div>

      <fieldset style={{ border: "none", padding: 0, margin: 0, display: "grid", gap: "0.75rem" }}>
        <legend style={{ fontSize: "0.85rem", fontWeight: 700 }}>Who is this for?</legend>
        <div className="field">
          <label htmlFor="invite-recipient-name">Name</label>
          <input id="invite-recipient-name" value={recipientName} onChange={(e) => setRecipientName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="invite-recipient-email">Email</label>
          <input id="invite-recipient-email" type="email" value={recipientEmail} onChange={(e) => setRecipientEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="invite-recipient-phone">Mobile number</label>
          <input id="invite-recipient-phone" type="tel" value={recipientPhone} onChange={(e) => setRecipientPhone(e.target.value)} />
        </div>
      </fieldset>

      <div className="field">
        <label htmlFor="invite-amount">Total amount ($)</label>
        <input id="invite-amount" type="number" min="0.01" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="invite-installment">Payment amount ($)</label>
        <input id="invite-installment" type="number" min="0.01" step="0.01" required value={installment} onChange={(e) => setInstallment(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="invite-frequency">How often will payments be made?</label>
        <select id="invite-frequency" value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)}>
          {Object.entries(FREQUENCY_LABEL).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="invite-first-date">First payment date</label>
        <input
          id="invite-first-date"
          type="date"
          required
          min={todayLocalIsoDate()}
          value={firstPaymentDate}
          onChange={(e) => setFirstPaymentDate(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="invite-message">Message (optional)</label>
        <input id="invite-message" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} />
      </div>

      {errorMessage && (
        <p className="field-error" role="alert">
          {errorMessage}
        </p>
      )}

      <button type="submit" className="button button--primary" disabled={submitState === "submitting"}>
        {submitState === "submitting" ? "Sending…" : "Send secure invitation"}
      </button>
    </form>
  );
}
