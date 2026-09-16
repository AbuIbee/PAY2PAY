"use client";

import "@adyen/adyen-web/styles/adyen.css";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";
import { getPublicEnv } from "@/config/public-env";
import { useStepUpGuardedAction } from "@/lib/ui/useStepUpGuardedAction";
import { StepUpChallenge } from "./StepUpChallenge";

interface ActiveProfile {
  kind: "personal" | "business";
  personalProfileId?: string;
  businessProfileId?: string;
}

type Stage =
  | "loading_identity"
  | "collecting_details"
  | "starting_session"
  | "collecting"
  | "confirming"
  | "pending_confirmation"
  | "done"
  | "error";

const STATUS_POLL_INTERVAL_MS = 2000;
const STATUS_POLL_MAX_ATTEMPTS = 15; // ~30s — generous for the two webhook round-trips (AUTHORISATION, then the token event) to land.

/**
 * PAID2YOU — B0-D ADYEN PHASE 2 (bank-account collection/tokenization). REPLACES this component's own
 * prior Phase 6A form (raw routing/account number fields POSTed directly to this server — see git
 * history / `paymentProvider.ts`'s `TokenizeBankAccountInput` doc comment). This component never
 * collects, receives, or transmits a routing/account number itself, in any form (plaintext or
 * otherwise) — the shopper types their bank details directly into Adyen's own hosted Web Component
 * (`@adyen/adyen-web`, the `Ach` element), which submits them DIRECTLY to Adyen using the session this
 * component obtains from Paid2You's server first — never through this server.
 *
 * PAID2YOU — B0-D ADYEN PHASE 2A (final bank-security correction): the client-triggered "finalize"
 * mutation this component used to POST is gone — see `BankConnectionService`'s own doc comment for why
 * (it trusted an unprovable before/after token-list diff). Completion now happens exclusively via two
 * Adyen webhooks Paid2You's server processes independently; this component's only remaining job after
 * `onPaymentCompleted` is to POLL the read-only GET status endpoint until the server reports
 * "completed" (or "failed"/"expired"). `institutionDisplayName` is now collected BEFORE the session is
 * created (`initiateBankConnection` persists it as part of the `bank_link_attempt` row itself), since
 * there is no later client-trusted call left to attach it to.
 *
 * Flow:
 *   1. Resolve the active profile, then let the shopper name their bank (optional) before anything
 *      provider-facing starts.
 *   2. `POST .../bank/session` (via `useStepUpGuardedAction`, mirroring this component's own prior MFA
 *      step-up wiring) to obtain a tokenization session.
 *   3. Dynamically import `@adyen/adyen-web` (never imported at module top level — this is a heavy,
 *      browser-only SDK; a dynamic import also means a missing/unavailable client key never breaks the
 *      page shell itself) and mount its `Ach` Component against that session.
 *   4. On `onPaymentCompleted`, poll `GET .../bank/connect` (ownership-checked, read-only) with the
 *      opaque `providerSessionId` until the server's own webhook-driven state machine reports this
 *      attempt "completed" — never assumed complete from the client-side SDK callback alone.
 *
 * Item 7 (fail-closed configuration): if `NEXT_PUBLIC_ADYEN_CLIENT_KEY` is not configured, this
 * component never attempts to fetch identity, start a session, or mount anything — `clientKey` is
 * checked directly at render time (never via `stage` state) and short-circuits to the "unavailable"
 * state, the same controlled state Adyen-side initialization failures fall back to.
 */
export function BankConnectionForm() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("loading_identity");
  const [party, setParty] = useState<{ kind: "personal" | "business"; id: string } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [institutionDisplayName, setInstitutionDisplayName] = useState("");
  const [detailsConfirmed, setDetailsConfirmed] = useState(false);
  const mountRef = useRef<HTMLDivElement>(null);
  const providerSessionIdRef = useRef<string | null>(null);
  const unmountComponentRef = useRef<(() => void) | null>(null);

  const clientKey = getPublicEnv().NEXT_PUBLIC_ADYEN_CLIENT_KEY;

  const sessionAction = useStepUpGuardedAction(
    (input: { actingParty: { kind: "personal" | "business"; id: string }; institutionDisplayName: string | null }) =>
      apiFetch<{ providerSessionId: string; sessionData: string }>("/api/relationships/accounts/bank/session", {
        method: "POST",
        body: JSON.stringify(input),
      }),
  );

  async function confirmConnection() {
    if (!party || !providerSessionIdRef.current) return;
    setStage("confirming");
    setErrorMessage(null);
    try {
      const query = new URLSearchParams({
        actingPartyKind: party.kind,
        actingPartyId: party.id,
        providerSessionId: providerSessionIdRef.current,
      });
      for (let attempt = 0; attempt < STATUS_POLL_MAX_ATTEMPTS; attempt++) {
        const result = await apiFetch<{ status: string; financialAccountId: string | null }>(
          `/api/relationships/accounts/bank/connect?${query.toString()}`,
        );
        if (result.status === "completed") {
          setStage("done");
          router.push("/payment-methods");
          router.refresh();
          return;
        }
        if (result.status === "failed" || result.status === "expired") {
          setStage("error");
          setErrorMessage("Your bank couldn't be connected. Please try again.");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));
      }
      // Still "pending"/"authorised" after ~30s — not a failure. The server keeps processing this
      // independently via Adyen's own webhook redelivery; never claim success OR failure here.
      setStage("pending_confirmation");
    } catch (error) {
      setStage("error");
      setErrorMessage(error instanceof Error ? error.message : "We couldn't check your bank connection status. Please try again.");
    }
  }

  // Item 7: never even attempts to resolve identity when the client key is missing — see this
  // component's own doc comment for why `clientKey` is checked at render time, not via `stage`.
  useEffect(() => {
    if (!clientKey) return;
    let cancelled = false;
    void (async () => {
      try {
        const active = await apiFetch<ActiveProfile>("/api/profiles/active");
        const id = active.kind === "business" ? active.businessProfileId : active.personalProfileId;
        if (!id) throw new Error("no active identity");
        if (!cancelled) {
          setParty({ kind: active.kind, id });
          setStage("collecting_details");
        }
      } catch {
        if (!cancelled) setStage("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientKey]);

  // PAID2YOU — B0-D ADYEN PHASE 2: deliberately depends on [party, clientKey, detailsConfirmed] —
  // NEVER `stage`. This effect itself calls `setStage(...)` as the flow progresses; including `stage`
  // in the dependency array would make every one of those updates re-trigger this same effect, running
  // its cleanup (which unmounts the just-mounted Adyen Component) immediately after mounting it.
  // `detailsConfirmed` is set only by the "Continue"/"Try again" button click handlers below (normal
  // event handlers, never inside this effect), so depending on it does not create the same
  // self-triggering problem — a "Try again" click flips it false then a fresh "Continue" click flips it
  // true again, which is the sole way this effect intentionally re-runs after `party`/`clientKey` are
  // already stable.
  useEffect(() => {
    if (!party || !clientKey || !detailsConfirmed) return;
    let cancelled = false;
    void (async () => {
      try {
        setStage("starting_session");
        const session = await sessionAction.run({ actingParty: party, institutionDisplayName: institutionDisplayName.trim() || null });
        if (cancelled) return;
        providerSessionIdRef.current = session.providerSessionId;

        const { AdyenCheckout, Ach } = await import("@adyen/adyen-web");
        if (cancelled) return;
        const checkout = await AdyenCheckout({
          environment: "live-us",
          clientKey,
          session: { id: session.providerSessionId, sessionData: session.sessionData },
          onPaymentCompleted: () => {
            if (!cancelled) void confirmConnection();
          },
          onPaymentFailed: () => {
            if (!cancelled) {
              setStage("error");
              setErrorMessage("Your bank couldn't be connected. Please try again.");
            }
          },
          onError: () => {
            if (!cancelled) {
              setStage("error");
              setErrorMessage("Something went wrong starting the secure bank connection. Please try again.");
            }
          },
        });
        if (cancelled || !mountRef.current) return;
        // No `enableStoreDetails` here — that prop shows the shopper an OPT-IN checkbox, which would
        // duplicate consent this flow's own session already establishes server-side
        // (`storePaymentMethodMode: "enabled"`, set unconditionally — never "askForConsent" — so
        // storage happens automatically, matching "Do not duplicate consent architecture").
        const component = new Ach(checkout, {});
        component.mount(mountRef.current);
        unmountComponentRef.current = () => component.unmount();
        setStage("collecting");
      } catch (error) {
        if (cancelled) return;
        setStage("error");
        setErrorMessage(error instanceof Error ? error.message : "Something went wrong. Please try again.");
      }
    })();
    return () => {
      cancelled = true;
      unmountComponentRef.current?.();
      unmountComponentRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionAction.run/confirmConnection/institutionDisplayName intentionally excluded: including them would re-run this effect (and tear down the mounted Component) on every unrelated render. institutionDisplayName is read once, at the moment detailsConfirmed flips true, via the "Continue" button's own snapshot — see that handler below.
  }, [party, clientKey, detailsConfirmed]);

  if (!clientKey) {
    return (
      <div className="empty-state">
        <h3>Not yet available</h3>
        <p>Connecting a bank account isn&apos;t available right now. We&apos;ll let you know when it is.</p>
      </div>
    );
  }

  if (stage === "loading_identity") {
    return <p role="status">Starting a secure connection to your bank…</p>;
  }

  if (stage === "error" && !party) {
    return (
      <p className="form-status form-status--error" role="alert">
        We couldn&apos;t determine which account to add this to. Please try again.
      </p>
    );
  }

  if (stage === "collecting_details") {
    return (
      <div style={{ display: "grid", gap: "1rem", maxWidth: "30rem" }}>
        <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: "0.85rem" }}>
          Your bank account and routing numbers are entered directly with our banking partner and are
          never seen or stored by PAY2PAY — only your bank&apos;s name and the last 4 digits of your
          account are kept on file.
        </p>

        <div className="field">
          <label htmlFor="bank-institution">Bank name (optional)</label>
          <input
            id="bank-institution"
            value={institutionDisplayName}
            onChange={(event) => setInstitutionDisplayName(event.target.value)}
            placeholder="e.g. First National Bank"
          />
        </div>

        <button type="button" className="button button--primary" onClick={() => setDetailsConfirmed(true)}>
          Continue
        </button>
      </div>
    );
  }

  // PAID2YOU — B0-D ADYEN PHASE 2: the mount <div> below must be present in the DOM from
  // "starting_session" onward — the session-creation effect needs `mountRef.current` populated the
  // instant Adyen's Component is ready to mount, which can happen before this component's OWN state
  // has transitioned to "collecting". Rendering it only for later stages left `mountRef.current` null
  // throughout the entire session-creation phase, silently dropping the mount call.
  return (
    <>
      <div style={{ display: "grid", gap: "1rem", maxWidth: "30rem" }}>
        {stage === "starting_session" && <p role="status">Starting a secure connection to your bank…</p>}

        <div ref={mountRef} />

        {stage === "confirming" && <p role="status">Confirming your bank connection…</p>}

        {stage === "pending_confirmation" && (
          <p role="status">
            Your bank connection is still being confirmed. This can take a few minutes — check your
            payment methods again shortly.
          </p>
        )}

        {errorMessage && (
          <p className="field-error" role="alert">
            {errorMessage}
          </p>
        )}

        {stage === "error" && party && (
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              setErrorMessage(null);
              setDetailsConfirmed(false);
              setStage("collecting_details");
            }}
          >
            Try again
          </button>
        )}
      </div>

      {sessionAction.isChallengeOpen && (
        <StepUpChallenge
          action="connect_bank_account"
          actionDescription="connect this bank account"
          onVerified={sessionAction.resolveChallenge}
          onCancel={sessionAction.cancelChallenge}
        />
      )}
    </>
  );
}
