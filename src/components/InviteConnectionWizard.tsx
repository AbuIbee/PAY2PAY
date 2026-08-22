"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/ui/apiFetch";
import { partyRoleLabel } from "@/lib/ui/statusLabels";

interface SelectableProfile {
  kind: "personal" | "business";
  personalProfileId?: string;
  businessProfileId?: string;
  displayName: string;
}

type Step = "identity" | "invitee" | "review" | "sent";
type MyRole = "creditor" | "debtor";

/**
 * Sprint 18B "Cooperative handshake UX" initiator flow: Create Connection ->
 * choose acting identity -> enter invitee -> review relationship context ->
 * submit -> "waiting for counterparty acceptance".
 */
export function InviteConnectionWizard() {
  const [step, setStep] = useState<Step>("identity");
  const [profiles, setProfiles] = useState<SelectableProfile[]>([]);
  const [profilesStatus, setProfilesStatus] = useState<"loading" | "ready" | "error">("loading");
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [inviteeEmail, setInviteeEmail] = useState("");
  const [myRole, setMyRole] = useState<MyRole>("creditor");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [relationshipId, setRelationshipId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ profiles: SelectableProfile[] }>("/api/profiles")
      .then((body) => {
        if (cancelled) return;
        setProfiles(body.profiles);
        if (body.profiles[0]) {
          const first = body.profiles[0];
          setSelectedKey(first.kind === "personal" ? "personal" : `business:${first.businessProfileId}`);
        }
        setProfilesStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setProfilesStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedProfile = profiles.find(
    (p) => (p.kind === "personal" ? "personal" : `business:${p.businessProfileId}`) === selectedKey,
  );

  async function handleSubmit() {
    if (!selectedProfile) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const actingParty =
        selectedProfile.kind === "personal"
          ? { kind: "personal" as const, id: selectedProfile.personalProfileId! }
          : { kind: "business" as const, id: selectedProfile.businessProfileId! };
      const inviteeRole: MyRole = myRole === "creditor" ? "debtor" : "creditor";
      const result = await apiFetch<{ relationship: { id: string } }>("/api/relationships/invite", {
        method: "POST",
        body: JSON.stringify({ actingParty, inviteeEmail, inviteeRole }),
      });
      setRelationshipId(result.relationship.id);
      setStep("sent");
    } catch (error) {
      setSubmitError(error instanceof ApiError ? error.message : "Could not send this invitation. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (profilesStatus === "loading") return <p role="status">Loading your identities…</p>;
  if (profilesStatus === "error") {
    return (
      <p className="form-status form-status--error" role="alert">
        Could not load your profiles. Please try again.
      </p>
    );
  }

  return (
    <div className="card" style={{ maxWidth: "34rem" }}>
      <div className="tabs" role="tablist" aria-label="Invite steps">
        {(["identity", "invitee", "review"] as Step[]).map((s) => (
          <span key={s} role="tab" aria-selected={step === s} className="tab" style={{ cursor: "default" }}>
            {s === "identity" ? "1. Identity" : s === "invitee" ? "2. Invitee" : "3. Review"}
          </span>
        ))}
      </div>

      {step === "identity" && (
        <div style={{ display: "grid", gap: "1rem" }}>
          <div className="field">
            <label htmlFor="acting-identity">Invite as</label>
            <select id="acting-identity" value={selectedKey} onChange={(event) => setSelectedKey(event.target.value)}>
              {profiles.map((profile) => {
                const key = profile.kind === "personal" ? "personal" : `business:${profile.businessProfileId}`;
                return (
                  <option key={key} value={key}>
                    {profile.displayName}
                  </option>
                );
              })}
            </select>
          </div>
          <div className="field">
            <label htmlFor="my-role">Your role in this relationship</label>
            <select id="my-role" value={myRole} onChange={(event) => setMyRole(event.target.value as MyRole)}>
              <option value="creditor">I&apos;m owed money (creditor)</option>
              <option value="debtor">I owe money (debtor)</option>
            </select>
          </div>
          <div className="dialog__actions" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="button button--primary" onClick={() => setStep("invitee")} disabled={!selectedProfile}>
              Continue
            </button>
          </div>
        </div>
      )}

      {step === "invitee" && (
        <div style={{ display: "grid", gap: "1rem" }}>
          <div className="field">
            <label htmlFor="invitee-email">Counterparty&apos;s email</label>
            <input
              id="invitee-email"
              type="email"
              required
              value={inviteeEmail}
              onChange={(event) => setInviteeEmail(event.target.value)}
            />
          </div>
          <div className="dialog__actions" style={{ justifyContent: "space-between" }}>
            <button type="button" className="button button--ghost" onClick={() => setStep("identity")}>
              Back
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={() => setStep("review")}
              disabled={!inviteeEmail.includes("@")}
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {step === "review" && selectedProfile && (
        <div style={{ display: "grid", gap: "1rem" }}>
          <div className="card" style={{ background: "var(--forest-50)" }}>
            <p style={{ margin: 0 }}>
              <strong>{selectedProfile.displayName}</strong>, {partyRoleLabel(myRole)}, is inviting{" "}
              <strong>{inviteeEmail}</strong>, who will be {partyRoleLabel(myRole === "creditor" ? "debtor" : "creditor")}.
            </p>
          </div>
          {submitError && (
            <p className="field-error" role="alert">
              {submitError}
            </p>
          )}
          <div className="dialog__actions" style={{ justifyContent: "space-between" }}>
            <button type="button" className="button button--ghost" onClick={() => setStep("invitee")} disabled={submitting}>
              Back
            </button>
            <button type="button" className="button button--primary" onClick={() => void handleSubmit()} disabled={submitting}>
              {submitting ? "Sending…" : "Send invitation"}
            </button>
          </div>
        </div>
      )}

      {step === "sent" && (
        <div className="empty-state">
          <h3>Waiting for counterparty acceptance</h3>
          <p>We&apos;ve sent an invitation to {inviteeEmail}. You&apos;ll be notified once they respond.</p>
          {relationshipId && (
            <Link href={`/connections/detail?id=${relationshipId}`} className="button button--primary">
              View connection
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
