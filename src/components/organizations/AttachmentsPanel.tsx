"use client";

import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/ui/apiFetch";

type ParentKind = "agreement" | "customer" | "obligation" | "none";

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  INVOICE: "Invoice",
  BILL_OF_LADING: "Bill of Lading",
  PROOF_OF_DELIVERY: "Proof of Delivery",
  RATE_CONFIRMATION: "Rate Confirmation",
  PURCHASE_ORDER: "Purchase Order",
  STATEMENT: "Statement",
  CONTRACT: "Contract",
  SUPPORTING_DOCUMENT: "Supporting Document",
  OTHER: "Other",
};

const DOCUMENT_TYPES = Object.keys(DOCUMENT_TYPE_LABELS);

interface AttachmentItem {
  id: string;
  documentType: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  uploadedByUserId: string;
  status: "active" | "archived";
  createdAt: string;
}

type Status = "loading" | "ready" | "denied" | "error";

function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * "PAID2YOU — SECURE BUSINESS ATTACHMENTS ITERATION" (2026-10-05): the ONE reusable Attachments
 * section — used contextually on the Agreement detail page, the Customers list, and the Outstanding
 * Balances list (Sections 15-17). Never a second, independent implementation. The server derives
 * `organizationId`/the parent resource from this component's own props (set by the PAGE, from
 * already-authorized context), never from user-entered input (Section 18).
 */
export function AttachmentsPanel({ organizationId, parentKind, parentId }: { organizationId: string; parentKind: ParentKind; parentId?: string }) {
  const [status, setStatus] = useState<Status>("loading");
  const [items, setItems] = useState<AttachmentItem[]>([]);
  const [canUpload, setCanUpload] = useState(false);
  const [documentType, setDocumentType] = useState("OTHER");
  const [file, setFile] = useState<File | null>(null);
  const [uploadStatus, setUploadStatus] = useState<"idle" | "working" | "error">("idle");
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  function listUrl(): string {
    const params = new URLSearchParams({ organizationId, parentKind });
    if (parentId) params.set("parentId", parentId);
    return `/api/organizations/attachments?${params.toString()}`;
  }

  /** Post-mutation refresh only (called from an event handler, never from the effect below). */
  async function load() {
    try {
      const body = await apiFetch<{ canUpload: boolean; items: AttachmentItem[] }>(listUrl());
      setItems(body.items);
      setCanUpload(body.canUpload);
      setStatus("ready");
    } catch (error) {
      setStatus(error instanceof ApiError && error.httpStatus === 403 ? "denied" : "error");
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await apiFetch<{ canUpload: boolean; items: AttachmentItem[] }>(listUrl());
        if (!cancelled) {
          setItems(body.items);
          setCanUpload(body.canUpload);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- listUrl is derived purely from these same props.
  }, [organizationId, parentKind, parentId]);

  async function handleUpload(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    setUploadStatus("working");
    const formData = new FormData();
    formData.set("file", file);
    formData.set("organizationId", organizationId);
    formData.set("documentType", documentType);
    formData.set("parentKind", parentKind);
    if (parentId) formData.set("parentId", parentId);
    const response = await fetch("/api/organizations/attachments", { method: "POST", body: formData });
    if (!response.ok) {
      setUploadStatus("error");
      return;
    }
    setUploadStatus("idle");
    setFile(null);
    void load();
  }

  async function handleDownload(attachmentId: string) {
    setDownloadingId(attachmentId);
    try {
      const params = new URLSearchParams({ organizationId, attachmentId });
      const body = await apiFetch<{ url: string }>(`/api/organizations/attachments/signed-url?${params.toString()}`);
      window.open(body.url, "_blank", "noopener,noreferrer");
    } catch {
      // Best-effort — a failed signed-URL fetch simply does not open a new tab.
    } finally {
      setDownloadingId(null);
    }
  }

  if (status === "loading") return <p role="status">Loading attachments…</p>;
  if (status === "denied") {
    return (
      <p className="form-status form-status--error" role="alert">
        You don&apos;t have permission to view attachments for this organization.
      </p>
    );
  }
  if (status === "error") {
    return (
      <p className="form-status form-status--error" role="alert">
        Something went wrong loading attachments. Please try again.
      </p>
    );
  }

  return (
    <div className="card">
      <div className="card__header">
        <h3>Attachments</h3>
      </div>

      {items.length === 0 ? (
        <p className="form-status">No attachments uploaded yet.</p>
      ) : (
        <div className="table-wrap table-wrap--responsive-cards">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Size</th>
                <th>Uploaded</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td data-label="Name">{item.fileName}</td>
                  <td data-label="Type">{DOCUMENT_TYPE_LABELS[item.documentType] ?? item.documentType}</td>
                  <td data-label="Size">{formatSize(item.sizeBytes)}</td>
                  <td data-label="Uploaded">{new Date(item.createdAt).toLocaleDateString()}</td>
                  <td data-label="">
                    <button type="button" className="button button--ghost" disabled={downloadingId === item.id} onClick={() => void handleDownload(item.id)}>
                      {downloadingId === item.id ? "Opening…" : "Download"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canUpload && (
        <form onSubmit={(event) => void handleUpload(event)} style={{ display: "grid", gap: "0.75rem", marginTop: "1rem" }}>
          <div className="early-access-form__row">
            <div className="field">
              <label htmlFor={`attachment-type-${parentKind}-${parentId ?? "org"}`}>Document type</label>
              <select id={`attachment-type-${parentKind}-${parentId ?? "org"}`} value={documentType} onChange={(event) => setDocumentType(event.target.value)}>
                {DOCUMENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {DOCUMENT_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor={`attachment-file-${parentKind}-${parentId ?? "org"}`}>File</label>
            <input
              id={`attachment-file-${parentKind}-${parentId ?? "org"}`}
              type="file"
              accept=".pdf,.png,.jpg,.jpeg"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              required
            />
          </div>
          {uploadStatus === "error" && (
            <p className="field-error" role="alert">
              Upload failed. Please check the file type/size and try again.
            </p>
          )}
          <button type="submit" className="button button--ghost" disabled={!file || uploadStatus === "working"}>
            {uploadStatus === "working" ? "Uploading…" : "Upload Attachment"}
          </button>
        </form>
      )}
    </div>
  );
}
