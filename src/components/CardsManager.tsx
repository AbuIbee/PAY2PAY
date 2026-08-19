"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/ui/apiFetch";
import { formatDate } from "@/lib/ui/date";
import { issuedCardStatusLabel } from "@/lib/ui/statusLabels";

interface ActiveProfile {
  kind: "personal" | "business";
  personalProfileId?: string;
  businessProfileId?: string;
}

interface IssuedCardRecord {
  id: string;
  cardType: "virtual" | "physical";
  cardLast4: string | null;
  cardBrand: string | null;
  expiresAtMonth: number | null;
  expiresAtYear: number | null;
  status:
    | "requested"
    | "pending_issuance"
    | "issued"
    | "active"
    | "frozen"
    | "lost"
    | "stolen"
    | "replaced"
    | "canceled";
  createdAt: string;
}

type LoadState = "loading" | "ready" | "unauthorized" | "error";

/**
 * PRSprint 24 (docs/prsprints/PRSPRINT_24_DEBIT_CARD_ISSUANCE_CARD_LIFECYCLE.md): minimal UI for the
 * PAY2PAY-issued card lifecycle — distinct from PaymentMethodsList (a card-on-file *the debtor*
 * registers for charging). Every action here calls the party-authorized `/api/cards/*` routes built
 * alongside CardService; this component only ever shows non-sensitive display metadata
 * (last4/brand/expiry), matching CardService's own PCI-scope boundary. Sandbox disclosure text
 * follows the Hard Stop rule ("Do not present sandbox/test capabilities as production-live").
 */
export function CardsManager() {
  const [state, setState] = useState<LoadState>("loading");
  const [party, setParty] = useState<{ kind: "personal" | "business"; id: string } | null>(null);
  const [cards, setCards] = useState<IssuedCardRecord[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingCardId, setPendingCardId] = useState<string | null>(null);
  const [showRequestForm, setShowRequestForm] = useState(false);

  async function loadCards(activeParty: { kind: "personal" | "business"; id: string }) {
    const body = await apiFetch<{ cards: IssuedCardRecord[] }>(
      `/api/cards/list?cardholderKind=${activeParty.kind}&cardholderId=${activeParty.id}`,
    );
    setCards(body.cards);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const active = await apiFetch<ActiveProfile>("/api/profiles/active");
        const id = active.kind === "business" ? active.businessProfileId : active.personalProfileId;
        if (!id) {
          if (!cancelled) setState("error");
          return;
        }
        const activeParty = { kind: active.kind, id };
        if (cancelled) return;
        setParty(activeParty);
        await loadCards(activeParty);
        if (!cancelled) setState("ready");
      } catch (error) {
        if (cancelled) return;
        if ((error as { httpStatus?: number }).httpStatus === 401) setState("unauthorized");
        else setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function runAction(cardId: string, run: () => Promise<unknown>) {
    if (!party) return;
    setPendingCardId(cardId);
    setActionError(null);
    try {
      await run();
      await loadCards(party);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Something went wrong. Please try again.");
    } finally {
      setPendingCardId(null);
    }
  }

  function handleActivate(cardId: string) {
    void runAction(cardId, () => apiFetch(`/api/cards/activate`, { method: "POST", body: JSON.stringify({ cardId }) }));
  }
  function handleFreeze(cardId: string) {
    void runAction(cardId, () => apiFetch(`/api/cards/freeze`, { method: "POST", body: JSON.stringify({ cardId }) }));
  }
  function handleUnfreeze(cardId: string) {
    void runAction(cardId, () => apiFetch(`/api/cards/unfreeze`, { method: "POST", body: JSON.stringify({ cardId }) }));
  }
  function handleReportLostStolen(cardId: string, reason: "lost" | "stolen") {
    if (!window.confirm(`Report this card ${reason}? A replacement card will be requested automatically.`)) return;
    void runAction(cardId, () =>
      apiFetch(`/api/cards/report-lost-stolen`, { method: "POST", body: JSON.stringify({ cardId, reason }) }),
    );
  }
  function handleCancel(cardId: string) {
    const reason = window.prompt("Why are you cancelling this card?");
    if (!reason || !reason.trim()) return;
    void runAction(cardId, () => apiFetch(`/api/cards/cancel`, { method: "POST", body: JSON.stringify({ cardId, reason }) }));
  }

  if (state === "loading") {
    return (
      <div className="card-grid">
        <div className="skeleton skeleton--card" />
        <div className="skeleton skeleton--card" />
      </div>
    );
  }

  if (state === "unauthorized") {
    return (
      <p className="form-status form-status--error" role="alert">
        You need to <Link href="/login">sign in</Link> to view your cards.
      </p>
    );
  }

  if (state === "error" || !party) {
    return (
      <p className="form-status form-status--error" role="alert">
        Something went wrong loading your cards. Please try again.
      </p>
    );
  }

  return (
    <div style={{ display: "grid", gap: "1.5rem" }}>
      <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: "0.85rem" }}>
        This is a sandbox card program — no real money moves and no card can be used for a real
        purchase. Card numbers are never shown here; only the last 4 digits and brand.
      </p>

      {actionError && (
        <p className="form-status form-status--error" role="alert">
          {actionError}
        </p>
      )}

      <div>
        <button type="button" className="button button--primary" onClick={() => setShowRequestForm((open) => !open)}>
          {showRequestForm ? "Close" : "Request a card"}
        </button>
      </div>

      {showRequestForm && party && (
        <RequestCardForm
          party={party}
          onRequested={() => {
            setShowRequestForm(false);
            void loadCards(party);
          }}
        />
      )}

      {cards.length === 0 ? (
        <div className="empty-state">
          <h3>No cards yet</h3>
          <p>Request a virtual or physical card to spend funds you&apos;ve received through PAY2PAY.</p>
        </div>
      ) : (
        <div className="card-grid">
          {cards.map((card) => (
            <CardTile
              key={card.id}
              card={card}
              pending={pendingCardId === card.id}
              onActivate={() => handleActivate(card.id)}
              onFreeze={() => handleFreeze(card.id)}
              onUnfreeze={() => handleUnfreeze(card.id)}
              onReportLostStolen={(reason) => handleReportLostStolen(card.id, reason)}
              onCancel={() => handleCancel(card.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CardTile({
  card,
  pending,
  onActivate,
  onFreeze,
  onUnfreeze,
  onReportLostStolen,
  onCancel,
}: {
  card: IssuedCardRecord;
  pending: boolean;
  onActivate: () => void;
  onFreeze: () => void;
  onUnfreeze: () => void;
  onReportLostStolen: (reason: "lost" | "stolen") => void;
  onCancel: () => void;
}) {
  const chip = issuedCardStatusLabel(card.status);
  const title = [card.cardBrand, card.cardType === "virtual" ? "virtual card" : "card"].filter(Boolean).join(" ");
  const canCancel = !["replaced", "lost", "stolen", "canceled"].includes(card.status);
  const canReport = ["issued", "active", "frozen"].includes(card.status);

  return (
    <div className="card">
      <div className="card__header">
        <div>
          <h3 style={{ textTransform: "capitalize" }}>{title || "Card"}</h3>
          <p style={{ margin: "0.25rem 0 0", color: "var(--ink-soft)", fontSize: "0.85rem" }}>
            {card.cardLast4 ? `Ending in ${card.cardLast4}` : "Not yet issued"}
            {card.expiresAtMonth && card.expiresAtYear
              ? ` · Expires ${String(card.expiresAtMonth).padStart(2, "0")}/${card.expiresAtYear}`
              : null}
          </p>
        </div>
        <span className={`chip chip--${chip.tone}`}>{chip.label}</span>
      </div>
      <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: "0.78rem" }}>Requested {formatDate(card.createdAt)}</p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "0.75rem" }}>
        {card.status === "issued" && (
          <button type="button" className="button button--primary" disabled={pending} onClick={onActivate}>
            Activate
          </button>
        )}
        {card.status === "active" && (
          <button type="button" className="button button--ghost" disabled={pending} onClick={onFreeze}>
            Freeze
          </button>
        )}
        {card.status === "frozen" && (
          <button type="button" className="button button--ghost" disabled={pending} onClick={onUnfreeze}>
            Unfreeze
          </button>
        )}
        {canReport && (
          <button type="button" className="button button--ghost" disabled={pending} onClick={() => onReportLostStolen("lost")}>
            Report lost
          </button>
        )}
        {canReport && (
          <button type="button" className="button button--ghost" disabled={pending} onClick={() => onReportLostStolen("stolen")}>
            Report stolen
          </button>
        )}
        {canCancel && (
          <button type="button" className="button button--ghost" disabled={pending} onClick={onCancel}>
            Cancel card
          </button>
        )}
      </div>
    </div>
  );
}

function RequestCardForm({
  party,
  onRequested,
}: {
  party: { kind: "personal" | "business"; id: string };
  onRequested: () => void;
}) {
  const [cardType, setCardType] = useState<"virtual" | "physical">("virtual");
  const [line1, setLine1] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [country, setCountry] = useState("US");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const shippingAddress =
        cardType === "physical" ? { line1, city, state, postalCode, country } : undefined;
      await apiFetch("/api/cards/request", {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          cardholderKind: party.kind,
          cardholderId: party.id,
          cardType,
          ...(shippingAddress ? { shippingAddress } : {}),
        }),
      });
      onRequested();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="card" style={{ display: "grid", gap: "1rem", maxWidth: "30rem" }}>
      <div className="field">
        <label htmlFor="card-type">Card type</label>
        <select id="card-type" value={cardType} onChange={(event) => setCardType(event.target.value as "virtual" | "physical")}>
          <option value="virtual">Virtual</option>
          <option value="physical">Physical</option>
        </select>
      </div>

      {cardType === "physical" && (
        <>
          <div className="field">
            <label htmlFor="ship-line1">Street address</label>
            <input id="ship-line1" required value={line1} onChange={(event) => setLine1(event.target.value)} />
          </div>
          <div className="early-access-form__row">
            <div className="field">
              <label htmlFor="ship-city">City</label>
              <input id="ship-city" required value={city} onChange={(event) => setCity(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="ship-state">State</label>
              <input id="ship-state" required value={state} onChange={(event) => setState(event.target.value)} />
            </div>
          </div>
          <div className="early-access-form__row">
            <div className="field">
              <label htmlFor="ship-postal">Postal code</label>
              <input id="ship-postal" required value={postalCode} onChange={(event) => setPostalCode(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="ship-country">Country</label>
              <input id="ship-country" required value={country} onChange={(event) => setCountry(event.target.value)} />
            </div>
          </div>
        </>
      )}

      {errorMessage && (
        <p className="field-error" role="alert">
          {errorMessage}
        </p>
      )}

      <button type="submit" className="button button--primary" disabled={submitting}>
        {submitting ? "Requesting…" : "Request card"}
      </button>
    </form>
  );
}
