"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useState } from "react";
import { apiFetch, ApiError } from "@/lib/ui/apiFetch";
import { formatMoney } from "@/lib/ui/money";
import { US_STATE_CODES, type UsStateCode } from "@/lib/us-states";

type BusinessIndustry = "TRUCKING" | "FREIGHT" | "THREE_PL" | "RETAIL" | "OTHER";

const INDUSTRY_OPTIONS: ReadonlyArray<{ value: BusinessIndustry; label: string }> = [
  { value: "TRUCKING", label: "Trucking" },
  { value: "FREIGHT", label: "Freight" },
  { value: "THREE_PL", label: "3PL" },
  { value: "RETAIL", label: "Retail" },
  { value: "OTHER", label: "Other" },
];

type OnboardingStep = "details_pending" | "details_complete" | "verification_submitted" | "tier_selected" | "billing_setup_complete";

interface LegalDocumentStatus {
  documentType: string;
  requiredVersion: string;
  accepted: boolean;
  acceptedVersion: string | null;
  acceptedAt: string | null;
}

interface OnboardingStateResponse {
  organizationId: string;
  displayName: string;
  onboardingStep: OnboardingStep;
  verification: { status: string; reviewRequired: boolean } | null;
  subscription: { status: string; pricingPlanId: string } | null;
  activation: {
    active: boolean;
    onboardingComplete: boolean;
    verificationStatus: string;
    subscriptionStatus: string;
    legalAcceptanceComplete: boolean;
    reasons: readonly string[];
  };
  legalAcceptance: readonly LegalDocumentStatus[];
}

type WizardStep = "details" | "verification" | "tier" | "legal" | "billing" | "active";

/** Section 3's own resumability invariant, mirrored client-side purely for display — the server's `onboardingStep`/`legalAcceptance` fields are the only source of truth for where to resume. */
function stepForServerState(state: OnboardingStateResponse): WizardStep {
  if (state.activation.active) return "active";
  switch (state.onboardingStep) {
    case "billing_setup_complete":
      return "active";
    case "tier_selected":
      // "PAID2YOU PRODUCTION LAUNCH", Phase 2, Section 8: legal acceptance is gated independently of
      // the onboardingStep enum (it is a 4th activation fact, not a 5th enum value — see
      // BusinessActivationService's own doc comment) — once the tier is selected, the wizard shows
      // Legal Agreements until every required document has a current acceptance, then Billing.
      return state.legalAcceptance.every((d) => d.accepted) ? "billing" : "legal";
    case "verification_submitted":
      return "tier";
    default:
      return "verification";
  }
}

const LEGAL_DOCUMENT_LABELS: Readonly<Record<string, { label: string; href: string }>> = {
  terms: { label: "Terms of Service", href: "/terms" },
  business_subscription_policy: { label: "Business Subscription Policy", href: "/business-subscription-policy" },
  recurring_payment_authorization: { label: "Recurring Payment Authorization", href: "/recurring-payment-authorization" },
};

interface BusinessDetailsFormState {
  legalBusinessName: string;
  displayName: string;
  entityType: string;
  dbaName: string;
  industry: BusinessIndustry | "";
  formationJurisdiction: string;
  line1: string;
  line2: string;
  city: string;
  state: UsStateCode | "";
  postalCode: string;
  businessEmail: string;
  businessPhone: string;
  website: string;
  repFirstName: string;
  repLastName: string;
  repTitle: string;
  repEmail: string;
  repPhone: string;
  repRelationship: string;
}

const BLANK_DETAILS: BusinessDetailsFormState = {
  legalBusinessName: "",
  displayName: "",
  entityType: "",
  dbaName: "",
  industry: "",
  formationJurisdiction: "",
  line1: "",
  line2: "",
  city: "",
  state: "",
  postalCode: "",
  businessEmail: "",
  businessPhone: "",
  website: "",
  repFirstName: "",
  repLastName: "",
  repTitle: "",
  repEmail: "",
  repPhone: "",
  repRelationship: "",
};

interface PlanOption {
  code: string;
  name: string;
  monthlyFeeMinorUnits: number | null;
  newArrangementsMonthlyLimit: number | null;
  minArrangementsMonthly: number | null;
}

/** Distinguishes "the server said no" from "we haven't asked yet" — never shown as a generic error. */
function providerUnavailableMessage(error: unknown, fallback: string): string | null {
  if (error instanceof ApiError && error.code === "PROVIDER_NOT_AVAILABLE") return fallback;
  return null;
}

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Section 2/3/4/5/6: the resumable Business onboarding
 * frontend — Business Details -> Verification -> Tier Selection -> Billing -> (independently
 * computed) Activation. Every step calls the existing BusinessOnboardingService-backed API routes
 * directly; this component holds no business rule, step-ordering, verification, billing, or
 * activation decision of its own — `stepForServerState` is a pure DISPLAY mapping of the server's own
 * `onboardingStep`/`activation` fields, recomputed from the server's response after every mutation and
 * on every mount, so reload/login-return/navigate-away always resumes at the server-authoritative
 * step rather than any locally-remembered progress.
 */
export function BusinessOnboardingWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlOrganizationId = searchParams.get("organizationId");

  const [loadStatus, setLoadStatus] = useState<"loading" | "ready" | "unauthorized" | "error">("loading");
  const [organizationId, setOrganizationId] = useState<string | null>(urlOrganizationId);
  const [serverState, setServerState] = useState<OnboardingStateResponse | null>(null);

  const refreshState = useCallback(async (id: string) => {
    const state = await apiFetch<OnboardingStateResponse>(`/api/organizations/onboarding/state?organizationId=${id}`);
    setServerState(state);
    return state;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!urlOrganizationId) {
        setLoadStatus("ready");
        return;
      }
      try {
        await refreshState(urlOrganizationId);
        if (!cancelled) setLoadStatus("ready");
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.httpStatus === 401) {
          setLoadStatus("unauthorized");
        } else {
          setLoadStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [urlOrganizationId, refreshState]);

  function handleOrganizationCreated(id: string) {
    setOrganizationId(id);
    router.replace(`/organizations/new?organizationId=${id}`);
    void refreshState(id);
  }

  if (loadStatus === "loading") return <p role="status">Loading…</p>;

  if (loadStatus === "unauthorized") {
    return (
      <p className="form-status form-status--error" role="alert">
        You need to <a href="/login">sign in</a> to set up a Business account.
      </p>
    );
  }

  if (loadStatus === "error") {
    return (
      <p className="form-status form-status--error" role="alert">
        Something went wrong loading your Business onboarding progress. Please try again.
      </p>
    );
  }

  if (!organizationId || !serverState) {
    return <BusinessDetailsStep organizationId={null} onSubmitted={handleOrganizationCreated} />;
  }

  const step = stepForServerState(serverState);
  return (
    <div style={{ display: "grid", gap: "1.5rem", maxWidth: "36rem" }}>
      <OnboardingProgress current={step} />
      {step === "verification" && (
        <VerificationStep organizationId={organizationId} onSubmitted={() => void refreshState(organizationId)} />
      )}
      {step === "tier" && <TierStep organizationId={organizationId} onSubmitted={() => void refreshState(organizationId)} />}
      {step === "legal" && <LegalStep organizationId={organizationId} onSubmitted={() => void refreshState(organizationId)} />}
      {step === "billing" && <BillingStep organizationId={organizationId} />}
      {step === "active" && <ActivationSummary state={serverState} />}
    </div>
  );
}

const PROGRESS_STEPS: ReadonlyArray<{ key: WizardStep; label: string }> = [
  { key: "details", label: "Business Details" },
  { key: "verification", label: "Verification" },
  { key: "tier", label: "Tier Selection" },
  { key: "legal", label: "Legal Agreements" },
  { key: "billing", label: "Billing" },
  { key: "active", label: "Active" },
];

function OnboardingProgress({ current }: { current: WizardStep }) {
  const currentIndex = PROGRESS_STEPS.findIndex((s) => s.key === current);
  return (
    <ol aria-label="Business onboarding progress" style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", padding: 0, margin: 0, listStyle: "none" }}>
      {PROGRESS_STEPS.map((s, index) => {
        const status = index < currentIndex ? "complete" : index === currentIndex ? "current" : "upcoming";
        return (
          <li key={s.key} aria-current={status === "current" ? "step" : undefined} className={`chip chip--${status === "complete" ? "success" : status === "current" ? "info" : "neutral"}`}>
            {status === "complete" ? "✓ " : ""}
            {s.label}
          </li>
        );
      })}
    </ol>
  );
}

function BusinessDetailsStep({
  organizationId,
  onSubmitted,
}: {
  organizationId: string | null;
  onSubmitted: (organizationId: string) => void;
}) {
  const formId = useId();
  const [value, setValue] = useState<BusinessDetailsFormState>(BLANK_DETAILS);
  const [status, setStatus] = useState<"idle" | "submitting" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  function setField<K extends keyof BusinessDetailsFormState>(key: K, fieldValue: BusinessDetailsFormState[K]) {
    setValue((prev) => ({ ...prev, [key]: fieldValue }));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setStatus("submitting");
    setError(null);
    try {
      const body = {
        organizationId,
        legalBusinessName: value.legalBusinessName,
        displayName: value.displayName,
        entityType: value.entityType,
        dbaName: value.dbaName || undefined,
        industry: value.industry,
        formationJurisdiction: value.formationJurisdiction,
        businessAddress: {
          line1: value.line1,
          line2: value.line2 || undefined,
          city: value.city,
          state: value.state,
          postalCode: value.postalCode,
        },
        businessEmail: value.businessEmail,
        businessPhone: value.businessPhone || undefined,
        website: value.website || undefined,
        country: "US",
        state: value.state,
        representative: {
          firstName: value.repFirstName,
          lastName: value.repLastName,
          title: value.repTitle,
          email: value.repEmail,
          phone: value.repPhone,
          relationshipToBusiness: value.repRelationship,
        },
      };
      const result = await apiFetch<{ organizationId: string }>("/api/organizations", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setStatus("idle");
      onSubmitted(result.organizationId);
    } catch (err) {
      setStatus("error");
      setError(err instanceof ApiError ? err.message : "Could not save business details. Please try again.");
    }
  }

  return (
    <form className="early-access-form" onSubmit={(event) => void handleSubmit(event)} aria-label="Business details">
      <h2 style={{ marginTop: 0 }}>Business Details</h2>

      <div className="field">
        <label htmlFor={`${formId}-legal-name`}>Legal business name</label>
        <input id={`${formId}-legal-name`} required value={value.legalBusinessName} onChange={(e) => setField("legalBusinessName", e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`${formId}-display-name`}>Display name</label>
        <input id={`${formId}-display-name`} required value={value.displayName} onChange={(e) => setField("displayName", e.target.value)} />
        <small>Shown to counterparties and your own team instead of the legal name.</small>
      </div>
      <div className="early-access-form__row">
        <div className="field">
          <label htmlFor={`${formId}-entity-type`}>Entity type</label>
          <input id={`${formId}-entity-type`} required placeholder="e.g. LLC, Corporation" value={value.entityType} onChange={(e) => setField("entityType", e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${formId}-dba`}>DBA/trade name (optional)</label>
          <input id={`${formId}-dba`} value={value.dbaName} onChange={(e) => setField("dbaName", e.target.value)} />
        </div>
      </div>
      <div className="early-access-form__row">
        <div className="field">
          <label htmlFor={`${formId}-industry`}>Industry</label>
          <select id={`${formId}-industry`} required value={value.industry} onChange={(e) => setField("industry", e.target.value as BusinessIndustry)}>
            <option value="">Select…</option>
            {INDUSTRY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${formId}-jurisdiction`}>Formation jurisdiction</label>
          <input id={`${formId}-jurisdiction`} required placeholder="e.g. Delaware" value={value.formationJurisdiction} onChange={(e) => setField("formationJurisdiction", e.target.value)} />
        </div>
      </div>

      <div className="field">
        <label htmlFor={`${formId}-line1`}>Business address line 1</label>
        <input id={`${formId}-line1`} required value={value.line1} onChange={(e) => setField("line1", e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`${formId}-line2`}>Address line 2 (optional)</label>
        <input id={`${formId}-line2`} value={value.line2} onChange={(e) => setField("line2", e.target.value)} />
      </div>
      <div className="early-access-form__row">
        <div className="field">
          <label htmlFor={`${formId}-city`}>City</label>
          <input id={`${formId}-city`} required value={value.city} onChange={(e) => setField("city", e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${formId}-state`}>State</label>
          <select id={`${formId}-state`} required value={value.state} onChange={(e) => setField("state", e.target.value as UsStateCode)}>
            <option value="">Select…</option>
            {US_STATE_CODES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${formId}-postal`}>ZIP/postal code</label>
          <input id={`${formId}-postal`} required value={value.postalCode} onChange={(e) => setField("postalCode", e.target.value)} />
        </div>
      </div>

      <div className="early-access-form__row">
        <div className="field">
          <label htmlFor={`${formId}-business-email`}>Business email</label>
          <input id={`${formId}-business-email`} type="email" required value={value.businessEmail} onChange={(e) => setField("businessEmail", e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${formId}-business-phone`}>Business phone (optional)</label>
          <input id={`${formId}-business-phone`} type="tel" value={value.businessPhone} onChange={(e) => setField("businessPhone", e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor={`${formId}-website`}>Website (optional)</label>
        <input id={`${formId}-website`} type="url" placeholder="https://" value={value.website} onChange={(e) => setField("website", e.target.value)} />
      </div>

      <fieldset style={{ border: "none", padding: 0, margin: 0, display: "grid", gap: "1rem" }}>
        <legend style={{ fontWeight: 600, padding: 0 }}>Authorized representative</legend>
        <div className="early-access-form__row">
          <div className="field">
            <label htmlFor={`${formId}-rep-first`}>First name</label>
            <input id={`${formId}-rep-first`} required value={value.repFirstName} onChange={(e) => setField("repFirstName", e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`${formId}-rep-last`}>Last name</label>
            <input id={`${formId}-rep-last`} required value={value.repLastName} onChange={(e) => setField("repLastName", e.target.value)} />
          </div>
        </div>
        <div className="early-access-form__row">
          <div className="field">
            <label htmlFor={`${formId}-rep-title`}>Title</label>
            <input id={`${formId}-rep-title`} required value={value.repTitle} onChange={(e) => setField("repTitle", e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`${formId}-rep-relationship`}>Relationship to business</label>
            <input id={`${formId}-rep-relationship`} required placeholder="e.g. Owner, CFO" value={value.repRelationship} onChange={(e) => setField("repRelationship", e.target.value)} />
          </div>
        </div>
        <div className="early-access-form__row">
          <div className="field">
            <label htmlFor={`${formId}-rep-email`}>Email</label>
            <input id={`${formId}-rep-email`} type="email" required value={value.repEmail} onChange={(e) => setField("repEmail", e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`${formId}-rep-phone`}>Phone</label>
            <input id={`${formId}-rep-phone`} type="tel" required value={value.repPhone} onChange={(e) => setField("repPhone", e.target.value)} />
          </div>
        </div>
      </fieldset>

      {status === "error" && error ? (
        <p className="form-status form-status--error" role="alert">
          {error}
        </p>
      ) : null}

      <button type="submit" className="button button--primary" disabled={status === "submitting"}>
        {status === "submitting" ? "Saving…" : "Next: Verification"}
      </button>
    </form>
  );
}

function VerificationStep({ organizationId, onSubmitted }: { organizationId: string; onSubmitted: () => void }) {
  const formId = useId();
  const [taxId, setTaxId] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "unavailable" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setStatus("submitting");
    setError(null);
    try {
      await apiFetch(`/api/organizations/onboarding/verification`, {
        method: "POST",
        body: JSON.stringify({ organizationId, taxId }),
      });
      setStatus("idle");
      onSubmitted();
    } catch (err) {
      const unavailable = providerUnavailableMessage(
        err,
        "Business verification isn't available yet — no live verification provider has been configured. Your business details have been saved, and you can try again once verification is available.",
      );
      if (unavailable) {
        setStatus("unavailable");
        setError(unavailable);
        return;
      }
      setStatus("error");
      setError(err instanceof ApiError ? err.message : "Could not submit verification. Please try again.");
    }
  }

  return (
    <form className="early-access-form" onSubmit={(event) => void handleSubmit(event)} aria-label="Business verification">
      <h2 style={{ marginTop: 0 }}>Verification Information</h2>
      <p>We use your Employer Identification Number (EIN) to verify your business. It is never stored in ordinary, readable form.</p>
      <div className="field">
        <label htmlFor={`${formId}-ein`}>Employer Identification Number (EIN)</label>
        <input id={`${formId}-ein`} required inputMode="numeric" value={taxId} onChange={(e) => setTaxId(e.target.value)} />
      </div>

      {status === "unavailable" && error ? (
        <p className="form-status" role="status">
          {error}
        </p>
      ) : null}
      {status === "error" && error ? (
        <p className="form-status form-status--error" role="alert">
          {error}
        </p>
      ) : null}

      <button type="submit" className="button button--primary" disabled={status === "submitting"}>
        {status === "submitting" ? "Submitting…" : "Submit for verification"}
      </button>
    </form>
  );
}

function TierStep({ organizationId, onSubmitted }: { organizationId: string; onSubmitted: () => void }) {
  const [loadStatus, setLoadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [plans, setPlans] = useState<PlanOption[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [submitStatus, setSubmitStatus] = useState<"idle" | "submitting" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await apiFetch<{ plans: PlanOption[] }>("/api/organizations/onboarding/plans");
        if (!cancelled) {
          setPlans(body.plans);
          setLoadStatus("ready");
        }
      } catch {
        if (!cancelled) setLoadStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit() {
    if (!selected) return;
    setSubmitStatus("submitting");
    setError(null);
    try {
      await apiFetch(`/api/organizations/onboarding/tier`, {
        method: "POST",
        body: JSON.stringify({ organizationId, planCode: selected }),
      });
      setSubmitStatus("idle");
      onSubmitted();
    } catch (err) {
      setSubmitStatus("error");
      setError(err instanceof ApiError ? err.message : "Could not select this plan. Please try again.");
    }
  }

  if (loadStatus === "loading") return <p role="status">Loading plans…</p>;
  if (loadStatus === "error") {
    return (
      <p className="form-status form-status--error" role="alert">
        Could not load Paid2You Business plans. Please try again.
      </p>
    );
  }

  return (
    <div className="early-access-form" aria-label="Tier selection">
      <h2 style={{ marginTop: 0 }}>Tier Selection</h2>
      <div role="radiogroup" aria-label="Paid2You Business plans" style={{ display: "grid", gap: "0.75rem" }}>
        {plans.map((plan) => {
          const isEnterprise = plan.newArrangementsMonthlyLimit === null;
          return (
            <label key={plan.code} className="checkbox-field" style={{ alignItems: "flex-start", padding: "0.75rem", border: "1px solid var(--border, #ddd)", borderRadius: "0.5rem" }}>
              <input type="radio" name="plan" value={plan.code} checked={selected === plan.code} onChange={() => setSelected(plan.code)} />
              <span>
                <strong>{plan.name}</strong>
                <br />
                {plan.monthlyFeeMinorUnits !== null ? (
                  <>
                    {isEnterprise ? "Starting at " : ""}
                    {formatMoney(plan.monthlyFeeMinorUnits)}/month
                  </>
                ) : (
                  "Custom pricing"
                )}
                {" — "}
                {isEnterprise
                  ? `${(plan.minArrangementsMonthly ?? 2_000).toLocaleString("en-US")}+ established arrangements/month, negotiated contract`
                  : `${(plan.minArrangementsMonthly ?? 0).toLocaleString("en-US")}–${plan.newArrangementsMonthlyLimit!.toLocaleString("en-US")} established arrangements/month`}
              </span>
            </label>
          );
        })}
      </div>

      {submitStatus === "error" && error ? (
        <p className="form-status form-status--error" role="alert">
          {error}
        </p>
      ) : null}

      <button type="button" className="button button--primary" disabled={!selected || submitStatus === "submitting"} onClick={() => void handleSubmit()}>
        {submitStatus === "submitting" ? "Saving…" : "Next: Legal Agreements"}
      </button>
    </div>
  );
}

/**
 * "PAID2YOU PRODUCTION LAUNCH" (2026-10-03), Phase 2, Section 3/8: every acceptance is a real,
 * server-recorded POST to `/api/organizations/onboarding/legal` — this component holds no
 * authoritative state of its own (Section 8: "Do not make React state authoritative"); `onSubmitted`
 * only re-fetches the server's own state, and `stepForServerState` (not this component) decides
 * whether Legal Agreements is still the current step.
 */
function LegalStep({ organizationId, onSubmitted }: { organizationId: string; onSubmitted: () => void }) {
  const [loadStatus, setLoadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [documents, setDocuments] = useState<LegalDocumentStatus[]>([]);
  const [acceptingType, setAcceptingType] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const body = await apiFetch<{ documents: LegalDocumentStatus[] }>(`/api/organizations/onboarding/legal?organizationId=${organizationId}`);
    setDocuments(body.documents);
  }, [organizationId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await refresh();
        if (!cancelled) setLoadStatus("ready");
      } catch {
        if (!cancelled) setLoadStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  async function handleAccept(documentType: string) {
    setAcceptingType(documentType);
    setError(null);
    try {
      await apiFetch("/api/organizations/onboarding/legal", { method: "POST", body: JSON.stringify({ organizationId, documentType }) });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record your acceptance. Please try again.");
    } finally {
      setAcceptingType(null);
    }
  }

  if (loadStatus === "loading") return <p role="status">Loading legal agreements…</p>;
  if (loadStatus === "error") {
    return (
      <p className="form-status form-status--error" role="alert">
        Could not load the required legal agreements. Please try again.
      </p>
    );
  }

  const allAccepted = documents.length > 0 && documents.every((d) => d.accepted);

  return (
    <div className="early-access-form" aria-label="Legal agreements">
      <h2 style={{ marginTop: 0 }}>Legal Agreements</h2>
      <p>Review and accept the following before continuing to billing setup.</p>
      <ul style={{ display: "grid", gap: "0.75rem", padding: 0, margin: 0, listStyle: "none" }}>
        {documents.map((doc) => {
          const meta = LEGAL_DOCUMENT_LABELS[doc.documentType] ?? { label: doc.documentType, href: "#" };
          return (
            <li key={doc.documentType} className="checkbox-field" style={{ alignItems: "center", padding: "0.75rem", border: "1px solid var(--border, #ddd)", borderRadius: "0.5rem", justifyContent: "space-between", display: "flex" }}>
              <span>
                {doc.accepted ? "✓ " : ""}
                <a href={meta.href} target="_blank" rel="noreferrer">
                  {meta.label}
                </a>
                {doc.accepted ? <span style={{ color: "var(--ink-soft)", fontSize: "var(--text-sm)" }}> — accepted (v{doc.acceptedVersion})</span> : null}
              </span>
              {!doc.accepted && (
                <button type="button" className="button button--secondary" disabled={acceptingType === doc.documentType} onClick={() => void handleAccept(doc.documentType)}>
                  {acceptingType === doc.documentType ? "Saving…" : "Accept"}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {error ? (
        <p className="form-status form-status--error" role="alert">
          {error}
        </p>
      ) : null}

      <button type="button" className="button button--primary" disabled={!allAccepted} onClick={onSubmitted}>
        Next: Billing
      </button>
    </div>
  );
}

/**
 * "PAID2YOU — MASTER P0 CLOSURE REMEDIATION" (2026-10-03), Section 7/8-D/9/10: redirects the Business
 * to the provider's own hosted checkout page — this form never collects a raw card/bank field or a
 * provider PaymentMethod id; `/api/organizations/onboarding/billing/checkout` returns only a
 * `hostedUrl` to navigate to. Returning here from Stripe (the `billing=success`/`billing=canceled`
 * query params `successUrl`/`cancelUrl` resolve to) is UX only — it does NOT mean the subscription is
 * active, since only a verified provider webhook can mark it so; the "waiting" notice below reflects
 * that honestly rather than assuming success.
 */
function BillingStep({ organizationId }: { organizationId: string }) {
  const formId = useId();
  const searchParams = useSearchParams();
  const returnedFromProvider = searchParams.get("billing");
  const [billingEmail, setBillingEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "unavailable" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setStatus("submitting");
    setError(null);
    try {
      const response = await apiFetch<{ hostedUrl: string }>(`/api/organizations/onboarding/billing/checkout`, {
        method: "POST",
        body: JSON.stringify({ organizationId, billingEmail }),
      });
      window.location.href = response.hostedUrl;
    } catch (err) {
      const unavailable = providerUnavailableMessage(
        err,
        "Subscription billing isn't available yet — no live billing provider has been configured. Your plan selection has been saved, and you can try again once billing is available.",
      );
      if (unavailable) {
        setStatus("unavailable");
        setError(unavailable);
        return;
      }
      setStatus("error");
      setError(err instanceof ApiError ? err.message : "Could not set up billing. Please try again.");
    }
  }

  return (
    <form className="early-access-form" onSubmit={(event) => void handleSubmit(event)} aria-label="Subscription billing">
      <h2 style={{ marginTop: 0 }}>Subscription Payment Method</h2>
      <p>You&apos;ll be redirected to our billing provider&apos;s secure page to enter your payment details. Paid2You never collects or stores your card or bank account number.</p>

      {returnedFromProvider === "success" ? (
        <p className="form-status" role="status">
          We&apos;re confirming your payment with the provider — this can take a few seconds. This page will update automatically once confirmed; refresh if it does not.
        </p>
      ) : null}
      {returnedFromProvider === "canceled" ? (
        <p className="form-status" role="status">
          Checkout was canceled — nothing was charged. You can try again below.
        </p>
      ) : null}

      <div className="field">
        <label htmlFor={`${formId}-billing-email`}>Billing email</label>
        <input id={`${formId}-billing-email`} type="email" required value={billingEmail} onChange={(e) => setBillingEmail(e.target.value)} />
      </div>

      {status === "unavailable" && error ? (
        <p className="form-status" role="status">
          {error}
        </p>
      ) : null}
      {status === "error" && error ? (
        <p className="form-status form-status--error" role="alert">
          {error}
        </p>
      ) : null}

      <button type="submit" className="button button--primary" disabled={status === "submitting"}>
        {status === "submitting" ? "Redirecting…" : "Continue to secure checkout"}
      </button>
    </form>
  );
}

function ActivationSummary({ state }: { state: OnboardingStateResponse }) {
  const { activation } = state;
  return (
    <div className="early-access-form" aria-label="Activation status">
      <h2 style={{ marginTop: 0 }}>{activation.active ? "Your business is active" : "Verification + Billing Eligibility"}</h2>
      {activation.active ? (
        <>
          <p>{state.displayName} is now active on Paid2You Business.</p>
          <a className="button button--primary" href={`/organizations/${state.organizationId}`}>
            Go to your business workspace
          </a>
        </>
      ) : (
        <>
          <p>Your onboarding steps are complete, but this organization is not active yet:</p>
          <ul>
            {activation.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
