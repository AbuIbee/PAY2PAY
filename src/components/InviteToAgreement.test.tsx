import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InviteToAgreement } from "./InviteToAgreement";

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
}

const LINK = "https://paid2you.example/i/abc123token";

function stubFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/profiles/active")) {
      return jsonResponse({ kind: "personal", personalProfileId: "profile-1", displayName: "Jane Doe" });
    }
    if (url.includes("/api/agreement-invitations")) {
      return jsonResponse({ id: "inv-1", status: "pending", expiresAt: new Date().toISOString(), rawToken: "abc123token", link: LINK }, true);
    }
    return jsonResponse({}, false);
  });
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>, opts: { email?: string; phone?: string }) {
  if (opts.email) await user.type(screen.getByLabelText(/^email$/i), opts.email);
  if (opts.phone) await user.type(screen.getByLabelText(/mobile number/i), opts.phone);
  await user.type(screen.getByLabelText(/total amount/i), "500");
  await user.type(screen.getByLabelText(/payment amount/i), "100");
  const dateInput = screen.getByLabelText(/first payment date/i);
  const future = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await user.type(dateInput, future);
  await user.click(screen.getByRole("button", { name: /send secure invitation/i }));
}

/**
 * B0-B blocker correction: covers item 9 (permitted non-Twilio sharing mechanisms remain functional)
 * and item 10 (no SMS UI falsely claims delivery when the automated Twilio SMS was blocked/never
 * attempted) from that pass's own required test list.
 */
describe("InviteToAgreement — pre-registration invitation SMS blocker correction (B0-B)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("10: never claims a text message was sent, and states the opt-in policy, when a phone number is provided", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const user = userEvent.setup();
    render(<InviteToAgreement />);
    await waitFor(() => expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument());

    await fillAndSubmit(user, { phone: "+15551234567" });

    await waitFor(() => expect(screen.getByRole("heading", { name: /invitation sent/i })).toBeInTheDocument());
    const bodyText = document.body.textContent ?? "";
    expect(bodyText.toLowerCase()).not.toContain("we've sent a secure link");
    expect(bodyText.toLowerCase()).not.toMatch(/we('| ha)ve (sent|texted) .*text/);
    expect(bodyText).toMatch(/paid2you can only send text-message invitations to users who have opted in/i);
  });

  it("does not show the SMS opt-in policy line when no phone number was provided", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const user = userEvent.setup();
    render(<InviteToAgreement />);
    await waitFor(() => expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument());

    await fillAndSubmit(user, { email: "recipient@example.com" });

    await waitFor(() => expect(screen.getByRole("heading", { name: /invitation sent/i })).toBeInTheDocument());
    expect(screen.getByText(/we've emailed a secure link to recipient@example\.com/i)).toBeInTheDocument();
    expect(screen.queryByText(/opted in to paid2you sms/i)).not.toBeInTheDocument();
  });

  it("9: Copy link and Share on WhatsApp remain available and functional when a phone number was provided", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const user = userEvent.setup();
    render(<InviteToAgreement />);
    await waitFor(() => expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument());

    await fillAndSubmit(user, { phone: "+15551234567" });
    await waitFor(() => expect(screen.getByRole("heading", { name: /invitation sent/i })).toBeInTheDocument());

    expect(screen.getByRole("button", { name: /copy link/i })).toBeInTheDocument();
    const whatsapp = screen.getByRole("link", { name: /share on whatsapp/i });
    expect(whatsapp).toHaveAttribute("href", expect.stringContaining("wa.me"));
    expect(whatsapp).toHaveAttribute("href", expect.stringContaining(encodeURIComponent(LINK)));
    expect(screen.getByText(LINK)).toBeInTheDocument();
  });

  it("8: the secure link/token is displayed regardless of whether a phone was provided", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const user = userEvent.setup();
    render(<InviteToAgreement />);
    await waitFor(() => expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument());

    await fillAndSubmit(user, { phone: "+15551234567" });
    await waitFor(() => expect(screen.getByText(LINK)).toBeInTheDocument());
  });
});
