"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  AgreementTermsFields,
  BLANK_AGREEMENT_TERMS,
  type AgreementTermsFormValues,
} from "./AgreementTermsFields";
import type { SelectableProfile } from "./ProfileSwitcher";

interface AgreementSummary {
  id: string;
  status: string;
  currency: string;
  relationshipShape: "P2P" | "B2C" | "C2B" | "B2B";
  createdAt: string;
}

type LoadStatus = "loading" | "ready" | "unauthorized" | "error";
type CreateStatus = "idle" | "submitting" | "error";

function activeProfileRef(profile: SelectableProfile): { kind: "personal" | "business"; id: string } | null {
  if (profile.kind === "personal") {
    return profile.personalProfileId ? { kind: "personal", id: profile.personalProfileId } : null;
  }
  return profile.businessProfileId ? { kind: "business", id: profile.businessProfileId } : null;
}

/**
 * Sprint 5 (docs/sprints/SPRINT_05_Agreement_Engine.md) functional UI: lists the active profile's
 * agreements and lets it draft a new one. Counterparty selection is a raw profile-ID input — this
 * project has no counterparty directory/search yet (out of scope for this sprint), so the form says
 * so plainly rather than pretending one exists.
 */
export function AgreementsList() {
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [active, setActive] = useState<SelectableProfile | null>(null);
  const [agreements, setAgreements] = useState<AgreementSummary[]>([]);
  const [showCreateForm, setShowCreateForm] = useState(false);

  const [myRole, setMyRole] = useState<"creditor" | "debtor">("creditor");
  const [counterpartyKind, setCounterpartyKind] = useState<"personal" | "business">("personal");
  const [counterpartyId, setCounterpartyId] = useState("");
  const [terms, setTerms] = useState<AgreementTermsFormValues>(BLANK_AGREEMENT_TERMS);
  const [createStatus, setCreateStatus] = useState<CreateStatus>("idle");
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const activeResponse = await fetch("/api/profiles/active");
    if (activeResponse.status === 401) {
      setLoadStatus("unauthorized");
      return;
    }
    if (!activeResponse.ok) {
      setLoadStatus("error");
      return;
    }
    const activeProfile = (await activeResponse.json()) as SelectableProfile;
    setActive(activeProfile);

    const ref = activeProfileRef(activeProfile);
    if (!ref) {
      setLoadStatus("error");
      return;
    }
    const listResponse = await fetch(`/api/agreements?profileKind=${ref.kind}&profileId=${ref.id}`);
    if (!listResponse.ok) {
      setLoadStatus("error");
      return;
    }
    const body = (await listResponse.json()) as { agreements: AgreementSummary[] };
    setAgreements(body.agreements);
    setLoadStatus("ready");
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await load();
      } catch {
        if (!cancelled) setLoadStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function handleCreate() {
    if (!active) return;
    const me = activeProfileRef(active);
    if (!me || !counterpartyId) {
      setCreateError("A counterparty profile ID is required.");
      setCreateStatus("error");
      return;
    }
    setCreateStatus("submitting");
    setCreateError(null);

    const creditor = myRole === "creditor" ? me : { kind: counterpartyKind, id: counterpartyId };
    const debtor = myRole === "debtor" ? me : { kind: counterpartyKind, id: counterpartyId };

    const response = await fetch("/api/agreements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ creditor, debtor, ...terms }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      setCreateError(body?.message ?? "Could not create the draft agreement.");
      setCreateStatus("error");
      return;
    }

    setCreateStatus("idle");
    setShowCreateForm(false);
    setTerms(BLANK_AGREEMENT_TERMS);
    setCounterpartyId("");
    await load();
  }

  if (loadStatus === "loading") return <p role="status">Loading agreements…</p>;

  if (loadStatus === "unauthorized") {
    return (
      <p className="form-status form-status--error" role="alert" style={{ maxWidth: "28rem" }}>
        You need to <a href="/login">sign in</a> to view agreements.
      </p>
    );
  }

  if (loadStatus === "error") {
    return (
      <p className="form-status form-status--error" role="alert" style={{ maxWidth: "28rem" }}>
        Something went wrong loading agreements. Please try again.
      </p>
    );
  }

  return (
    <div style={{ display: "grid", gap: "1.5rem", maxWidth: "40rem" }}>
      <div>
        {agreements.length === 0 ? (
          <p>No agreements yet for {active?.displayName ?? "this profile"}.</p>
        ) : (
          <ul style={{ display: "grid", gap: "0.75rem", padding: 0, margin: 0, listStyle: "none" }}>
            {agreements.map((agreement) => (
              <li key={agreement.id} className="early-access-form" style={{ padding: "1rem" }}>
                <Link href={`/agreements/detail?id=${agreement.id}`}>
                  {agreement.relationshipShape} — {agreement.status.replaceAll("_", " ")}
                </Link>
                <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--ink-soft)" }}>
                  {agreement.currency} · created {new Date(agreement.createdAt).toLocaleDateString()}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="hero__actions">
        <button type="button" className="button button--primary" onClick={() => setShowCreateForm((v) => !v)}>
          {showCreateForm ? "Cancel" : "Draft a new agreement"}
        </button>
      </div>

      {showCreateForm ? (
        <form
          className="early-access-form"
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreate();
          }}
        >
          <div className="field">
            <span style={{ fontSize: "0.8rem", fontWeight: 700 }}>My role in this agreement</span>
            <div className="early-access-form__row" role="radiogroup">
              <div className="checkbox-field">
                <input
                  id="role-creditor"
                  type="radio"
                  checked={myRole === "creditor"}
                  onChange={() => setMyRole("creditor")}
                />
                <label htmlFor="role-creditor">I am the creditor (owed money)</label>
              </div>
              <div className="checkbox-field">
                <input
                  id="role-debtor"
                  type="radio"
                  checked={myRole === "debtor"}
                  onChange={() => setMyRole("debtor")}
                />
                <label htmlFor="role-debtor">I am the debtor (I owe money)</label>
              </div>
            </div>
          </div>

          <div className="early-access-form__row">
            <div className="field">
              <label htmlFor="counterparty-kind">Counterparty profile type</label>
              <select
                id="counterparty-kind"
                value={counterpartyKind}
                onChange={(event) => setCounterpartyKind(event.target.value as "personal" | "business")}
              >
                <option value="personal">Personal</option>
                <option value="business">Business</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="counterparty-id">Counterparty profile ID</label>
              <input
                id="counterparty-id"
                value={counterpartyId}
                onChange={(event) => setCounterpartyId(event.target.value)}
                placeholder="Their profile UUID"
                required
              />
              <small>There is no counterparty directory yet — ask them for their profile ID directly.</small>
            </div>
          </div>

          <AgreementTermsFields values={terms} onChange={(patch) => setTerms((v) => ({ ...v, ...patch }))} />

          {createStatus === "error" && createError ? (
            <p className="form-status form-status--error" role="alert">
              {createError}
            </p>
          ) : null}

          <button type="submit" className="button button--primary" disabled={createStatus === "submitting"}>
            {createStatus === "submitting" ? "Creating…" : "Create draft"}
          </button>
        </form>
      ) : null}
    </div>
  );
}
