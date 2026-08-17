"use client";

import Link from "next/link";
import { useState } from "react";

interface BusinessSummary {
  id: string;
  legalBusinessName: string;
  displayName: string;
  status: string;
  ownerEmail: string;
}

type SearchStatus = "idle" | "searching" | "unauthorized" | "forbidden" | "error";

/** PRSprint 11B (docs/prsprints/PRSPRINT_11B_ADMIN_CONSOLE_CONTROLLED_SUPPORT_ACCESS.md) — mirrors AdminUsers.tsx's exact shape for business_profile search. */
export function AdminBusinesses() {
  const [name, setName] = useState("");
  const [businessId, setBusinessId] = useState("");
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [results, setResults] = useState<BusinessSummary[]>([]);

  async function handleSearch(event: React.FormEvent) {
    event.preventDefault();
    setStatus("searching");
    const params = new URLSearchParams();
    if (name.trim()) params.set("name", name.trim());
    if (businessId.trim()) params.set("businessId", businessId.trim());
    const response = await fetch(`/api/admin/businesses?${params.toString()}`);
    if (response.status === 401) return setStatus("unauthorized");
    if (response.status === 403) return setStatus("forbidden");
    if (!response.ok) return setStatus("error");
    const body = (await response.json()) as { businesses: BusinessSummary[] };
    setResults(body.businesses);
    setStatus("idle");
  }

  return (
    <div style={{ display: "grid", gap: "1.5rem", maxWidth: "40rem" }}>
      <form className="early-access-form" onSubmit={(event) => void handleSearch(event)}>
        <div className="early-access-form__row">
          <div className="field">
            <label htmlFor="admin-business-search-name">Business or legal name</label>
            <input id="admin-business-search-name" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="admin-business-search-id">Business ID</label>
            <input id="admin-business-search-id" value={businessId} onChange={(event) => setBusinessId(event.target.value)} />
          </div>
        </div>
        <button type="submit" className="button button--primary" disabled={status === "searching"}>
          {status === "searching" ? "Searching…" : "Search"}
        </button>
        {status === "unauthorized" ? (
          <p className="form-status form-status--error" role="alert">
            You need to <a href="/login">sign in</a> to search businesses.
          </p>
        ) : null}
        {status === "forbidden" ? (
          <p className="form-status form-status--error" role="alert">
            You do not have administrative access.
          </p>
        ) : null}
        {status === "error" ? (
          <p className="form-status form-status--error" role="alert">
            Something went wrong. Please try again.
          </p>
        ) : null}
      </form>

      {results.length > 0 ? (
        <ul style={{ display: "grid", gap: "0.5rem", padding: 0, margin: 0, listStyle: "none" }}>
          {results.map((business) => (
            <li key={business.id} className="early-access-form" style={{ padding: "1rem" }}>
              <Link href={`/admin/businesses/detail?id=${business.id}`}>{business.displayName}</Link>
              <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--ink-soft)" }}>
                {business.legalBusinessName} · {business.status} · owner: {business.ownerEmail}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
