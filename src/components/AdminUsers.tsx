"use client";

import Link from "next/link";
import { useState } from "react";

interface UserSummary {
  id: string;
  email: string;
  status: string;
  platformRole: string;
  accountClassification: string;
}

type SearchStatus = "idle" | "searching" | "unauthorized" | "forbidden" | "error";

export function AdminUsers() {
  const [email, setEmail] = useState("");
  const [userId, setUserId] = useState("");
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [results, setResults] = useState<UserSummary[]>([]);

  async function handleSearch(event: React.FormEvent) {
    event.preventDefault();
    setStatus("searching");
    const params = new URLSearchParams();
    if (email.trim()) params.set("email", email.trim());
    if (userId.trim()) params.set("userId", userId.trim());
    const response = await fetch(`/api/admin/users?${params.toString()}`);
    if (response.status === 401) return setStatus("unauthorized");
    if (response.status === 403) return setStatus("forbidden");
    if (!response.ok) return setStatus("error");
    const body = (await response.json()) as { users: UserSummary[] };
    setResults(body.users);
    setStatus("idle");
  }

  return (
    <div style={{ display: "grid", gap: "1.5rem", maxWidth: "40rem" }}>
      <form className="early-access-form" onSubmit={(event) => void handleSearch(event)}>
        <div className="early-access-form__row">
          <div className="field">
            <label htmlFor="admin-search-email">Email</label>
            <input id="admin-search-email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="admin-search-id">User ID</label>
            <input id="admin-search-id" value={userId} onChange={(event) => setUserId(event.target.value)} />
          </div>
        </div>
        <button type="submit" className="button button--primary" disabled={status === "searching"}>
          {status === "searching" ? "Searching…" : "Search"}
        </button>
        {status === "unauthorized" ? (
          <p className="form-status form-status--error" role="alert">
            You need to <a href="/login">sign in</a> to search users.
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
          {results.map((user) => (
            <li key={user.id} className="early-access-form" style={{ padding: "1rem" }}>
              <Link href={`/admin/users/detail?id=${user.id}`}>{user.email}</Link>
              <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--ink-soft)" }}>
                {user.platformRole} · {user.status} · {user.accountClassification}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
