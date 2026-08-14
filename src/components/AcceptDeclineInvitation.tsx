"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/ui/apiFetch";

interface SelectableProfile {
  kind: "personal" | "business";
  personalProfileId?: string;
  businessProfileId?: string;
  displayName: string;
}

interface ResolveResult {
  found: boolean;
  inviteeEmail?: string;
  inviteeRole?: "creditor" | "debtor";
}

type Status = "checking_session" | "signed_out" | "loading_context" | "ready" | "responded" | "error";

/**
 * Sprint 18B cooperative handshake: existing-user and new-user-via-signup
 * flows both land here. "Signup must never auto-accept a financial
 * relationship" — this screen never accepts automatically; Accept/Decline
 * are always explicit user actions.
 */
export function AcceptDeclineInvitation() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const invitationId = searchParams.get("invitationId");
  const token = searchParams.get("token") ?? undefined;

  const [status, setStatus] = useState<Status>("checking_session");
  const [context, setContext] = useState<ResolveResult | null>(null);
  const [profiles, setProfiles] = useState<SelectableProfile[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [responding, setResponding] = useState(false);
  const [responseError, setResponseError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<"accepted" | "declined" | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ id: string }>("/api/auth/me")
      .then(async () => {
        if (cancelled) return;
        setStatus("loading_context");
        if (token) {
          try {
            const result = await apiFetch<ResolveResult>(`/api/relationships/invite/resolve?token=${encodeURIComponent(token)}`);
            if (!cancelled) setContext(result);
          } catch {
            // Non-fatal — proceed without preview context.
          }
        }
        try {
          const profilesBody = await apiFetch<{ profiles: SelectableProfile[] }>("/api/profiles");
          if (cancelled) return;
          setProfiles(profilesBody.profiles);
          if (profilesBody.profiles[0]) {
            const first = profilesBody.profiles[0];
            setSelectedKey(first.kind === "personal" ? "personal" : `business:${first.businessProfileId}`);
          }
          setStatus("ready");
        } catch {
          if (!cancelled) setStatus("error");
        }
      })
      .catch(() => {
        if (!cancelled) setStatus("signed_out");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const selectedProfile = profiles.find(
    (p) => (p.kind === "personal" ? "personal" : `business:${p.businessProfileId}`) === selectedKey,
  );

  async function handleAccept() {
    if (!invitationId || !selectedProfile) return;
    setResponding(true);
    setResponseError(null);
    try {
      const actingParty =
        selectedProfile.kind === "personal"
          ? { kind: "personal" as const, id: selectedProfile.personalProfileId! }
          : { kind: "business" as const, id: selectedProfile.businessProfileId! };
      await apiFetch("/api/relationships/accept", {
        method: "POST",
        body: JSON.stringify({ invitationId, actingParty, rawToken: token }),
      });
      setOutcome("accepted");
      setStatus("responded");
    } catch (error) {
      setResponseError(error instanceof ApiError ? error.message : "Could not accept this invitation.");
    } finally {
      setResponding(false);
    }
  }

  async function handleDecline() {
    if (!invitationId) return;
    setResponding(true);
    setResponseError(null);
    try {
      await apiFetch("/api/relationships/decline", { method: "POST", body: JSON.stringify({ invitationId, rawToken: token }) });
      setOutcome("declined");
      setStatus("responded");
    } catch (error) {
      setResponseError(error instanceof ApiError ? error.message : "Could not decline this invitation.");
    } finally {
      setResponding(false);
    }
  }

  if (!invitationId) {
    return (
      <p className="form-status form-status--error" role="alert">
        No invitation was specified.
      </p>
    );
  }

  if (status === "checking_session" || status === "loading_context") {
    return <p role="status">Loading…</p>;
  }

  if (status === "signed_out") {
    return (
      <div className="empty-state">
        <h3>Sign in to respond</h3>
        <p>Sign in or create an account, then open this invitation link again to accept or decline it.</p>
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <a href="/login" className="button button--primary">Sign in</a>
          <a href="/signup" className="button button--ghost">Create account</a>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <p className="form-status form-status--error" role="alert">
        Something went wrong loading this invitation. Please try again.
      </p>
    );
  }

  if (status === "responded") {
    return (
      <div className="empty-state">
        <h3>{outcome === "accepted" ? "Invitation accepted" : "Invitation declined"}</h3>
        {outcome === "accepted" ? (
          <button type="button" className="button button--primary" onClick={() => router.push("/connections")}>
            Go to Connections
          </button>
        ) : (
          <p>You can safely close this page.</p>
        )}
      </div>
    );
  }

  return (
    <div className="card" style={{ maxWidth: "32rem" }}>
      <p>
        You&apos;ve been invited to a repayment connection
        {context?.found && context.inviteeRole ? ` as the ${context.inviteeRole === "creditor" ? "creditor (owed money)" : "debtor (owes money)"}` : ""}.
      </p>
      <div className="field">
        <label htmlFor="accept-identity">Respond as</label>
        <select id="accept-identity" value={selectedKey} onChange={(event) => setSelectedKey(event.target.value)}>
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
      {responseError && (
        <p className="field-error" role="alert">
          {responseError}
        </p>
      )}
      <div className="dialog__actions" style={{ justifyContent: "flex-start", gap: "0.75rem" }}>
        <button type="button" className="button button--primary" onClick={() => void handleAccept()} disabled={responding || !selectedProfile}>
          Accept
        </button>
        <button type="button" className="button button--ghost" onClick={() => void handleDecline()} disabled={responding}>
          Decline
        </button>
      </div>
    </div>
  );
}
