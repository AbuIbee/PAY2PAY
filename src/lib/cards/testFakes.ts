import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { createTestVerificationService } from "@/lib/profiles/testFakes";
import { createTestStaffService } from "@/lib/staff/testFakes";
import { CardService } from "./cardService";
import type { IssuedCardRecord, IssuedCardRepository } from "./cardService";
import { CardWebhookService } from "./cardWebhookService";
import type { CardTransactionEventRecord, CardTransactionEventRepository, CardTransactionEventType, IssuedCardRefResolver } from "./cardWebhookService";
import { SandboxCardIssuingProvider } from "./sandboxCardIssuingProvider";

/** Test-only in-memory doubles for CardService, mirroring src/lib/ach/testFakes.ts's pattern. */

export class InMemoryIssuedCardRepository implements IssuedCardRepository {
  byId = new Map<string, IssuedCardRecord>();
  private idempotencyKeys = new Set<string>();

  async insert(input: {
    idempotencyKey: string;
    individualProfileId: string | null;
    organizationId: string | null;
    cardType: "virtual" | "physical";
    providerName: string;
    shippingAddress: Record<string, string> | null;
    requestedByUserId: string;
    supersedesCardId: string | null;
  }): Promise<IssuedCardRecord> {
    if (this.idempotencyKeys.has(input.idempotencyKey)) {
      throw new Error("duplicate idempotency key");
    }
    this.idempotencyKeys.add(input.idempotencyKey);
    const now = new Date();
    const record: IssuedCardRecord = {
      id: randomUUID(),
      status: "requested",
      providerCardRef: null,
      cardLast4: null,
      cardBrand: null,
      expiresAtMonth: null,
      expiresAtYear: null,
      activatedAt: null,
      frozenAt: null,
      frozenReason: null,
      closedAt: null,
      closedReason: null,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<IssuedCardRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<IssuedCardRecord | null> {
    return [...this.byId.values()].find((r) => r.idempotencyKey === idempotencyKey) ?? null;
  }

  async findByProviderCardRef(providerCardRef: string): Promise<IssuedCardRecord | null> {
    return [...this.byId.values()].find((r) => r.providerCardRef === providerCardRef) ?? null;
  }

  async listForParty(individualProfileId: string | null, organizationId: string | null): Promise<IssuedCardRecord[]> {
    return [...this.byId.values()].filter(
      (r) => (individualProfileId && r.individualProfileId === individualProfileId) || (organizationId && r.organizationId === organizationId),
    );
  }

  async markPendingIssuance(id: string): Promise<IssuedCardRecord> {
    return this.update(id, { status: "pending_issuance" });
  }

  async markIssued(
    id: string,
    input: { providerCardRef: string; cardLast4: string; cardBrand: string | null; expiresAtMonth: number; expiresAtYear: number },
  ): Promise<IssuedCardRecord> {
    return this.update(id, { status: "issued", ...input });
  }

  async markRequestFailed(id: string): Promise<IssuedCardRecord> {
    return this.update(id, { status: "requested" });
  }

  async markActivated(id: string, activatedAt: Date): Promise<IssuedCardRecord> {
    return this.update(id, { status: "active", activatedAt });
  }

  async markFrozen(id: string, frozenAt: Date, reason: string | null): Promise<IssuedCardRecord> {
    return this.update(id, { status: "frozen", frozenAt, frozenReason: reason });
  }

  async markUnfrozen(id: string): Promise<IssuedCardRecord> {
    return this.update(id, { status: "active", frozenAt: null, frozenReason: null });
  }

  async markLostOrStolen(id: string, status: "lost" | "stolen"): Promise<IssuedCardRecord> {
    return this.update(id, { status, closedAt: new Date() });
  }

  async markReplaced(id: string, _supersededBy: string): Promise<IssuedCardRecord> {
    void _supersededBy;
    return this.update(id, { status: "replaced" });
  }

  async markCanceled(id: string, closedAt: Date, reason: string): Promise<IssuedCardRecord> {
    return this.update(id, { status: "canceled", closedAt, closedReason: reason });
  }

  private update(id: string, patch: Partial<IssuedCardRecord>): IssuedCardRecord {
    const record = this.byId.get(id);
    if (!record) throw new Error("issued_card not found");
    Object.assign(record, patch, { updatedAt: new Date() });
    return record;
  }
}

class InMemoryAuditEventRepositoryForCards implements AuditEventRepository {
  events: AuditEventRecord[] = [];
  private nextId = 1;

  async getLastEvent(): Promise<AuditEventRecord | null> {
    return this.events.at(-1) ?? null;
  }

  async insertEvent(record: Omit<AuditEventRecord, "id">): Promise<AuditEventRecord> {
    const stored: AuditEventRecord = { ...record, id: this.nextId++ };
    this.events.push(stored);
    return stored;
  }
}

const TEST_CARD_WEBHOOK_SECRET = "test-sandbox-card-webhook-secret";

/** Builds a full CardService test context sharing the same underlying VerificationService/StaffService instances real requests share. */
export function createTestCardServices() {
  const verificationCtx = createTestVerificationService();
  const staffCtx = createTestStaffService();
  const provider = new SandboxCardIssuingProvider(TEST_CARD_WEBHOOK_SECRET);
  const cards = new InMemoryIssuedCardRepository();
  const auditRepo = new InMemoryAuditEventRepositoryForCards();
  const cardService = new CardService({
    cards,
    provider,
    verification: verificationCtx.verificationService,
    profileOwners: verificationCtx.profileOwners,
    staffService: staffCtx.staffService,
    audit: new AuditService(auditRepo),
  });
  return { verificationCtx, staffCtx, provider, cards, auditRepo, cardService };
}

export class InMemoryCardTransactionEventRepository implements CardTransactionEventRepository {
  private byId = new Map<string, CardTransactionEventRecord>();

  async findByProviderEvent(provider: string, providerEventId: string): Promise<CardTransactionEventRecord | null> {
    return [...this.byId.values()].find((e) => e.provider === provider && e.providerEventId === providerEventId) ?? null;
  }

  async insert(input: {
    issuedCardId: string;
    provider: string;
    providerEventId: string;
    eventType: CardTransactionEventType;
    providerTransactionRef: string;
    amountMinorUnits: number;
    currency: string;
    merchantDisplayName: string | null;
    signatureVerified: boolean;
    payload: unknown;
  }): Promise<CardTransactionEventRecord> {
    const key = `${input.provider}:${input.providerEventId}`;
    if ([...this.byId.values()].some((e) => `${e.provider}:${e.providerEventId}` === key)) {
      throw new Error("duplicate card transaction event");
    }
    const record: CardTransactionEventRecord = { id: randomUUID(), receivedAt: new Date(), processedAt: null, ...input };
    this.byId.set(record.id, record);
    return record;
  }

  async markProcessed(id: string): Promise<void> {
    const record = this.byId.get(id);
    if (record) record.processedAt = new Date();
  }

  async listForCard(issuedCardId: string): Promise<CardTransactionEventRecord[]> {
    return [...this.byId.values()].filter((e) => e.issuedCardId === issuedCardId);
  }
}

export class InMemoryIssuedCardRefResolver implements IssuedCardRefResolver {
  constructor(private readonly cards: InMemoryIssuedCardRepository) {}

  async findIdByProviderCardRef(providerCardRef: string): Promise<string | null> {
    const found = [...this.cards.byId.values()].find((c) => c.providerCardRef === providerCardRef);
    return found?.id ?? null;
  }
}

/** Builds a full CardWebhookService test context sharing an existing CardService context's provider/cards repo. */
export function createTestCardWebhookService(cardCtx: ReturnType<typeof createTestCardServices>) {
  const events = new InMemoryCardTransactionEventRepository();
  const cardWebhookService = new CardWebhookService({
    provider: cardCtx.provider,
    events,
    cards: new InMemoryIssuedCardRefResolver(cardCtx.cards),
  });
  return { events, cardWebhookService };
}
