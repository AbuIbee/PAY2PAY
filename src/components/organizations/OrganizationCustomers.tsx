"use client";

import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/ui/apiFetch";

interface CustomerItem {
  id: string;
  displayName: string;
  externalCustomerReference: string | null;
  status: "active" | "archived";
  createdAt: string;
}

type Status = "loading" | "ready" | "denied" | "error";

export function OrganizationCustomers({ organizationId }: { organizationId: string }) {
  const [status, setStatus] = useState<Status>("loading");
  const [items, setItems] = useState<CustomerItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await apiFetch<{ items: CustomerItem[] }>(`/api/organizations/customers?organizationId=${organizationId}`);
        if (!cancelled) {
          setItems(body.items);
          setStatus("ready");
        }
      } catch (error) {
        if (cancelled) return;
        setStatus(error instanceof ApiError && error.httpStatus === 403 ? "denied" : "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  if (status === "loading") return <p role="status">Loading…</p>;
  if (status === "denied") {
    return (
      <p className="form-status form-status--error" role="alert">
        You don&apos;t have permission to view this organization&apos;s customers.
      </p>
    );
  }
  if (status === "error") {
    return (
      <p className="form-status form-status--error" role="alert">
        Something went wrong. Please try again.
      </p>
    );
  }

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Customers</h2>
      {items.length === 0 ? (
        <p>No customers have been added yet.</p>
      ) : (
        <ul style={{ display: "grid", gap: "0.75rem", padding: 0, margin: 0, listStyle: "none" }}>
          {items.map((item) => (
            <li key={item.id} className="early-access-form" style={{ padding: "1rem" }}>
              <strong>{item.displayName}</strong>
              <span className={`chip chip--${item.status === "active" ? "success" : "neutral"}`} style={{ marginLeft: "0.5rem" }}>
                {item.status}
              </span>
              {item.externalCustomerReference ? <p style={{ margin: "0.35rem 0 0", fontSize: "0.8rem", color: "var(--ink-soft)" }}>Ref {item.externalCustomerReference}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
