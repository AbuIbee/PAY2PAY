import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BusinessOnboardingWizard } from "./BusinessOnboardingWizard";

const replace = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => mockSearchParams,
}));

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 300, status, json: async () => body };
}

function errorResponse(status: number, code: string, message: string) {
  return { ok: false, status, json: async () => ({ status: "error", code, message }) };
}

describe("BusinessOnboardingWizard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    replace.mockClear();
    mockSearchParams = new URLSearchParams();
  });

  it("starts fresh at Business Details when there is no organizationId in the URL", async () => {
    render(<BusinessOnboardingWizard />);
    expect(await screen.findByRole("heading", { name: "Business Details" })).toBeInTheDocument();
  });

  it("submitting Business Details creates the organization and advances to Verification, updating the URL so a reload resumes correctly", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === "/api/organizations" && init?.method === "POST") {
        return jsonResponse({ organizationId: "org-1", displayName: "ABC", onboardingStep: "details_complete" }, 201);
      }
      if (input === "/api/organizations/onboarding/state?organizationId=org-1") {
        return jsonResponse({
          organizationId: "org-1",
          displayName: "ABC",
          onboardingStep: "details_complete",
          verification: null,
          subscription: null,
          activation: { active: false, onboardingComplete: false, verificationStatus: "not_submitted", subscriptionStatus: "not_subscribed", reasons: ["x"] },
        });
      }
      throw new Error(`Unhandled fetch: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<BusinessOnboardingWizard />);

    await user.type(screen.getByLabelText("Legal business name"), "ABC Trucking LLC");
    await user.type(screen.getByLabelText("Display name"), "ABC Trucking");
    await user.type(screen.getByLabelText("Entity type"), "LLC");
    await user.selectOptions(screen.getByLabelText("Industry"), "TRUCKING");
    await user.type(screen.getByLabelText("Formation jurisdiction"), "Delaware");
    await user.type(screen.getByLabelText("Business address line 1"), "1 Main St");
    await user.type(screen.getByLabelText("City"), "Dover");
    await user.selectOptions(screen.getByLabelText("State"), "DE");
    await user.type(screen.getByLabelText("ZIP/postal code"), "19901");
    await user.type(screen.getByLabelText("Business email"), "billing@abc.com");
    await user.type(screen.getByLabelText("First name"), "Jane");
    await user.type(screen.getByLabelText("Last name"), "Doe");
    await user.type(screen.getByLabelText("Title"), "CEO");
    await user.type(screen.getByLabelText("Relationship to business"), "Owner");
    await user.type(screen.getByLabelText("Email"), "jane@abc.com");
    await user.type(screen.getByLabelText("Phone"), "+15555550100");

    await user.click(screen.getByRole("button", { name: "Next: Verification" }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/organizations/new?organizationId=org-1"));
    expect(await screen.findByRole("heading", { name: "Verification Information" })).toBeInTheDocument();
  });

  it("resumes at the server-authoritative step on mount when organizationId is already in the URL (reload/login-return)", async () => {
    mockSearchParams = new URLSearchParams({ organizationId: "org-1" });
    const fetchMock = vi.fn().mockImplementation(async (input: string) => {
      if (input.startsWith("/api/organizations/onboarding/state")) {
        return jsonResponse({
          organizationId: "org-1",
          displayName: "ABC",
          onboardingStep: "verification_submitted",
          verification: { status: "pending", reviewRequired: false },
          subscription: null,
          activation: { active: false, onboardingComplete: false, verificationStatus: "pending", subscriptionStatus: "not_subscribed", reasons: ["x"] },
        });
      }
      if (input === "/api/organizations/onboarding/plans") {
        return jsonResponse({ plans: [] });
      }
      throw new Error(`Unhandled fetch: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<BusinessOnboardingWizard />);
    expect(await screen.findByRole("heading", { name: "Tier Selection" })).toBeInTheDocument();
    // Never shown Business Details again — local component state never overrides the server step.
    expect(screen.queryByRole("heading", { name: "Business Details" })).not.toBeInTheDocument();
  });

  it("the Verification step represents a NOT_CONFIGURED provider honestly, without fabricating success or losing onboarding progress", async () => {
    mockSearchParams = new URLSearchParams({ organizationId: "org-1" });
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.startsWith("/api/organizations/onboarding/state")) {
        return jsonResponse({
          organizationId: "org-1",
          displayName: "ABC",
          onboardingStep: "details_complete",
          verification: null,
          subscription: null,
          activation: { active: false, onboardingComplete: false, verificationStatus: "not_submitted", subscriptionStatus: "not_subscribed", reasons: ["x"] },
        });
      }
      if (input === "/api/organizations/onboarding/verification" && init?.method === "POST") {
        return errorResponse(503, "PROVIDER_NOT_AVAILABLE", "This feature is not available yet.");
      }
      throw new Error(`Unhandled fetch: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<BusinessOnboardingWizard />);

    await user.type(await screen.findByLabelText("Employer Identification Number (EIN)"), "123456789");
    await user.click(screen.getByRole("button", { name: "Submit for verification" }));

    expect(await screen.findByRole("status")).toHaveTextContent(/isn't available yet/i);
    expect(screen.queryByText(/verified/i)).not.toBeInTheDocument();
  });

  it("the Tier step lists canonical plans from the server and selecting one advances to Legal Agreements", async () => {
    mockSearchParams = new URLSearchParams({ organizationId: "org-1" });
    // Stateful mock: the state-fetch reflects the server's own onboardingStep AFTER the tier POST
    // succeeds — exercising the same "refetch server truth after every mutation" path the real
    // component relies on for resumability, not a fixed canned response.
    let onboardingStep = "verification_submitted";
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.startsWith("/api/organizations/onboarding/state")) {
        return jsonResponse({
          organizationId: "org-1",
          displayName: "ABC",
          onboardingStep,
          verification: { status: "pending", reviewRequired: false },
          subscription: null,
          activation: { active: false, onboardingComplete: false, verificationStatus: "pending", subscriptionStatus: "not_subscribed", legalAcceptanceComplete: false, reasons: ["x"] },
          legalAcceptance: ["terms", "business_subscription_policy", "recurring_payment_authorization"].map((documentType) => ({
            documentType,
            requiredVersion: "v1",
            accepted: false,
            acceptedVersion: null,
            acceptedAt: null,
          })),
        });
      }
      if (input === "/api/organizations/onboarding/plans") {
        return jsonResponse({
          plans: [
            { code: "paid2you_business_core", name: "Core", monthlyFeeMinorUnits: 19_900, newArrangementsMonthlyLimit: 99, minArrangementsMonthly: 25 },
            { code: "paid2you_business_enterprise", name: "Enterprise", monthlyFeeMinorUnits: 500_000, newArrangementsMonthlyLimit: null, minArrangementsMonthly: 2_000 },
          ],
        });
      }
      if (input === "/api/organizations/onboarding/tier" && init?.method === "POST") {
        onboardingStep = "tier_selected";
        return jsonResponse({ pricingPlanId: "plan-1", status: "active" }, 201);
      }
      if (input.startsWith("/api/organizations/onboarding/legal")) {
        return jsonResponse({
          documents: [
            { documentType: "terms", requiredVersion: "v1", accepted: false, acceptedVersion: null, acceptedAt: null },
            { documentType: "business_subscription_policy", requiredVersion: "v1", accepted: false, acceptedVersion: null, acceptedAt: null },
            { documentType: "recurring_payment_authorization", requiredVersion: "v1", accepted: false, acceptedVersion: null, acceptedAt: null },
          ],
        });
      }
      throw new Error(`Unhandled fetch: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<BusinessOnboardingWizard />);

    expect(await screen.findByText(/\$199\.00\/month/)).toBeInTheDocument();
    expect(screen.getByText(/25–99 established arrangements\/month/)).toBeInTheDocument();
    // Enterprise is never shown as a fixed universal price.
    expect(screen.getByText(/Starting at \$5,000\.00\/month/)).toBeInTheDocument();
    expect(screen.getByText(/2,000\+ established arrangements\/month, negotiated contract/)).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /Core/ }));
    await user.click(screen.getByRole("button", { name: "Next: Legal Agreements" }));

    expect(await screen.findByRole("heading", { name: "Legal Agreements" })).toBeInTheDocument();
  });

  it("the Legal Agreements step requires every document accepted before advancing, then reaches Billing", async () => {
    mockSearchParams = new URLSearchParams({ organizationId: "org-1" });
    const acceptedTypes = new Set<string>();
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.startsWith("/api/organizations/onboarding/state")) {
        return jsonResponse({
          organizationId: "org-1",
          displayName: "ABC",
          onboardingStep: "tier_selected",
          verification: { status: "pending", reviewRequired: false },
          subscription: null,
          activation: { active: false, onboardingComplete: false, verificationStatus: "pending", subscriptionStatus: "not_subscribed", legalAcceptanceComplete: acceptedTypes.size === 3, reasons: ["x"] },
          legalAcceptance: ["terms", "business_subscription_policy", "recurring_payment_authorization"].map((documentType) => ({
            documentType,
            requiredVersion: "v1",
            accepted: acceptedTypes.has(documentType),
            acceptedVersion: acceptedTypes.has(documentType) ? "v1" : null,
            acceptedAt: acceptedTypes.has(documentType) ? "2026-10-03T00:00:00.000Z" : null,
          })),
        });
      }
      if (input.startsWith("/api/organizations/onboarding/legal") && (!init || init.method === undefined)) {
        return jsonResponse({
          documents: ["terms", "business_subscription_policy", "recurring_payment_authorization"].map((documentType) => ({
            documentType,
            requiredVersion: "v1",
            accepted: acceptedTypes.has(documentType),
            acceptedVersion: acceptedTypes.has(documentType) ? "v1" : null,
            acceptedAt: acceptedTypes.has(documentType) ? "2026-10-03T00:00:00.000Z" : null,
          })),
        });
      }
      if (input === "/api/organizations/onboarding/legal" && init?.method === "POST") {
        const body = JSON.parse(init.body as string) as { documentType: string };
        acceptedTypes.add(body.documentType);
        return jsonResponse({ documentType: body.documentType, documentVersion: "v1", acceptedAt: "2026-10-03T00:00:00.000Z" }, 201);
      }
      throw new Error(`Unhandled fetch: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<BusinessOnboardingWizard />);

    expect(await screen.findByRole("heading", { name: "Legal Agreements" })).toBeInTheDocument();
    const nextButton = screen.getByRole("button", { name: "Next: Billing" });
    expect(nextButton).toBeDisabled();

    await user.click(screen.getAllByRole("button", { name: "Accept" })[0]!);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Accept" })).toHaveLength(2));
    await user.click(screen.getAllByRole("button", { name: "Accept" })[0]!);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Accept" })).toHaveLength(1));
    await user.click(screen.getAllByRole("button", { name: "Accept" })[0]!);

    await waitFor(() => expect(screen.getByRole("button", { name: "Next: Billing" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Next: Billing" }));

    expect(await screen.findByRole("heading", { name: "Subscription Payment Method" })).toBeInTheDocument();
  });

  it("the Billing step represents a NOT_CONFIGURED provider honestly and never claims the subscription was activated", async () => {
    mockSearchParams = new URLSearchParams({ organizationId: "org-1" });
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.startsWith("/api/organizations/onboarding/state")) {
        return jsonResponse({
          organizationId: "org-1",
          displayName: "ABC",
          onboardingStep: "tier_selected",
          verification: { status: "pending", reviewRequired: false },
          subscription: null,
          activation: { active: false, onboardingComplete: false, verificationStatus: "pending", subscriptionStatus: "not_subscribed", legalAcceptanceComplete: true, reasons: ["x"] },
          legalAcceptance: ["terms", "business_subscription_policy", "recurring_payment_authorization"].map((documentType) => ({
            documentType,
            requiredVersion: "v1",
            accepted: true,
            acceptedVersion: "v1",
            acceptedAt: "2026-10-03T00:00:00.000Z",
          })),
        });
      }
      if (input === "/api/organizations/onboarding/billing/checkout" && init?.method === "POST") {
        return errorResponse(503, "PROVIDER_NOT_AVAILABLE", "Billing is not available yet.");
      }
      throw new Error(`Unhandled fetch: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<BusinessOnboardingWizard />);

    await user.type(await screen.findByLabelText("Billing email"), "billing@abc.com");
    await user.click(screen.getByRole("button", { name: "Continue to secure checkout" }));

    expect(await screen.findByRole("status")).toHaveTextContent(/isn't available yet/i);
    expect(screen.queryByText(/payment method attached/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/subscription activated/i)).not.toBeInTheDocument();
  });

  it("shows the real activation reasons rather than fabricating ACTIVE when onboarding steps are complete but activation is not yet true", async () => {
    mockSearchParams = new URLSearchParams({ organizationId: "org-1" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          organizationId: "org-1",
          displayName: "ABC Trucking",
          onboardingStep: "billing_setup_complete",
          verification: { status: "pending", reviewRequired: false },
          subscription: { status: "active", pricingPlanId: "plan-1" },
          activation: {
            active: false,
            onboardingComplete: true,
            verificationStatus: "pending",
            subscriptionStatus: "active",
            reasons: ["Business verification is not yet complete."],
          },
        }),
      ),
    );
    render(<BusinessOnboardingWizard />);

    expect(await screen.findByText("Business verification is not yet complete.")).toBeInTheDocument();
    expect(screen.queryByText("Your business is now active on Paid2You Business.")).not.toBeInTheDocument();
  });

  it("shows the active workspace link once the server reports activation is actually true", async () => {
    mockSearchParams = new URLSearchParams({ organizationId: "org-1" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          organizationId: "org-1",
          displayName: "ABC Trucking",
          onboardingStep: "billing_setup_complete",
          verification: { status: "verified", reviewRequired: false },
          subscription: { status: "active", pricingPlanId: "plan-1" },
          activation: { active: true, onboardingComplete: true, verificationStatus: "verified", subscriptionStatus: "active", reasons: [] },
        }),
      ),
    );
    render(<BusinessOnboardingWizard />);

    expect(await screen.findByRole("link", { name: "Go to your business workspace" })).toHaveAttribute("href", "/organizations/org-1");
  });
});
