"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/ui/apiFetch";
import { formatDateTime } from "@/lib/ui/date";

type ProfileKind = "personal" | "business";

interface PendingVerificationRecord {
  id: string;
  profileKind: ProfileKind;
  profileId: string;
  tier: string;
  createdAt: string;
}

/**
 * Closed-beta remediation (DEF-UAT-020): the first admin UI ever built for identity-verification
 * decisions — VerificationService.recordManualVerificationDecision existed since Sprint 3 with zero
 * caller. Approving/rejecting here is what actually unblocks agreement signing and payment creation
 * for the profile in question (both gate unconditionally on isFullyVerified).
 */
export function AdminVerificationQueue() {
  const [records, setRecords] = useState<PendingVerificationRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const body = await apiFetch<{ records: PendingVerificationRecord[] }>("/api/admin/verification");
      setRecords(body.records);
    } catch (error) {
      if (error instanceof ApiError && error.httpStatus === 403) {
        setLoadError("You do not have the decide_identity_verification capability required to view this queue.");
      } else {
        setLoadError(error instanceof Error ? error.message : "Something went wrong loading pending verification requests.");
      }
      setRecords(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  async function handleDecide(record: PendingVerificationRecord, decision: "verified" | "rejected") {
    const reason = rejectReason[record.id]?.trim() ?? "";
    if (decision === "rejected" && !reason) {
      setActionError("A reason is required when rejecting a verification request.");
      return;
    }
    setPendingId(record.id);
    setActionError(null);
    try {
      await apiFetch("/api/admin/verification/decide", {
        method: "POST",
        body: JSON.stringify({
          profileKind: record.profileKind,
          profileId: record.profileId,
          decision,
          reason: reason || null,
        }),
      });
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Something went wrong recording this decision.");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div>
      <div className="card">
        <div className="card__header">
          <h2>Identity verification queue</h2>
        </div>
        <p className="app-page__lede">
          Approving here is what actually lets this profile sign an agreement or create a payment — both are
          blocked unconditionally until a request here is decided.
        </p>

        {loading && records === null && <div className="skeleton skeleton--card" aria-hidden="true" />}
        {loadError && (
          <p className="form-status form-status--error" role="alert">
            {loadError}
          </p>
        )}
        {actionError && (
          <p className="field-error" role="alert">
            {actionError}
          </p>
        )}

        {records !== null && records.length === 0 && (
          <div className="empty-state">
            <h3>No pending requests</h3>
            <p>You&apos;ll see a profile here as soon as it requests full verification.</p>
          </div>
        )}

        {records !== null && records.length > 0 && (
          <div className="table-wrap table-wrap--responsive-cards">
            <table className="table">
              <thead>
                <tr>
                  <th>Profile</th>
                  <th>Tier</th>
                  <th>Requested</th>
                  <th>Reason (required to reject)</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.id}>
                    <td data-label="Profile">
                      {record.profileKind === "personal" ? "Personal" : "Business"} · {record.profileId}
                    </td>
                    <td data-label="Tier">{record.tier}</td>
                    <td data-label="Requested">{formatDateTime(record.createdAt)}</td>
                    <td data-label="Reason">
                      <input
                        type="text"
                        aria-label={`Decision reason for ${record.profileId}`}
                        value={rejectReason[record.id] ?? ""}
                        onChange={(event) => setRejectReason((prev) => ({ ...prev, [record.id]: event.target.value }))}
                        placeholder="Reason (required to reject)"
                      />
                    </td>
                    <td data-label="" style={{ display: "flex", gap: "0.5rem" }}>
                      <button
                        type="button"
                        className="button button--primary"
                        disabled={pendingId === record.id}
                        onClick={() => void handleDecide(record, "verified")}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="button button--ghost"
                        disabled={pendingId === record.id}
                        onClick={() => void handleDecide(record, "rejected")}
                      >
                        Reject
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
