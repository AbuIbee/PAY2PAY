import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentsPanel } from "./AttachmentsPanel";

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 300, status, json: async () => body };
}
function errorResponse(status: number, code: string, message: string) {
  return { ok: false, status, json: async () => ({ status: "error", code, message }) };
}

describe("AttachmentsPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the attachments list and hides the upload form when canUpload is false (view-only)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ canUpload: false, items: [{ id: "a1", documentType: "INVOICE", fileName: "invoice.pdf", mimeType: "application/pdf", sizeBytes: 1024, uploadedByUserId: "u1", status: "active", createdAt: "2026-10-05T00:00:00.000Z" }] }),
      ),
    );
    render(<AttachmentsPanel organizationId="org-1" parentKind="agreement" parentId="agr-1" />);
    expect(await screen.findByText("invoice.pdf")).toBeInTheDocument();
    expect(screen.getByText("Invoice")).toBeInTheDocument();
    expect(screen.queryByText("Upload Attachment")).not.toBeInTheDocument();
  });

  it("shows the upload form when canUpload is true, and uploads a file", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: "a2", documentType: "OTHER", fileName: "new.pdf" }, 201));
      }
      if (url.includes("/api/organizations/attachments")) {
        return Promise.resolve(jsonResponse({ canUpload: true, items: [] }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<AttachmentsPanel organizationId="org-1" parentKind="customer" parentId="cust-1" />);
    expect(await screen.findByText("No attachments uploaded yet.")).toBeInTheDocument();
    expect(screen.getByText("Upload Attachment")).toBeInTheDocument();

    const file = new File(["%PDF-1.4"], "new.pdf", { type: "application/pdf" });
    const input = screen.getByLabelText(/^File$/) as HTMLInputElement;
    await user.upload(input, file);
    expect(input.files?.[0]?.name).toBe("new.pdf");
    const submitButton = screen.getByText("Upload Attachment");
    expect(submitButton).not.toBeDisabled();
    // jsdom does not recognize a programmatically-set `input.files` as satisfying a `required`
    // file input's constraint validation, so a real browser-style `user.click` on the submit button
    // is silently blocked here — this is a confirmed jsdom limitation, not a production behavior
    // difference. `fireEvent.submit` dispatches the submit event directly, bypassing that gate, to
    // prove the component's own onSubmit handler (not browser-native validation) is what's under test.
    fireEvent.submit(submitButton.closest("form")!);

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === "POST");
      expect(postCall).toBeTruthy();
    });
  });

  it("shows a denied message when the server returns 403", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(403, "FORBIDDEN", "denied")));
    render(<AttachmentsPanel organizationId="org-1" parentKind="obligation" parentId="obl-1" />);
    expect(await screen.findByText(/don't have permission to view attachments/)).toBeInTheDocument();
  });

  it("shows an organization-general attachments list when parentKind is none", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ canUpload: false, items: [] })));
    render(<AttachmentsPanel organizationId="org-1" parentKind="none" />);
    expect(await screen.findByText("No attachments uploaded yet.")).toBeInTheDocument();
  });
});
