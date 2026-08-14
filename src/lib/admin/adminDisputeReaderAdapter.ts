import "server-only";
import type { AgreementDisputeRecord, AgreementDisputeRepository } from "@/lib/disputes/agreementDisputeService";
import type { PaymentDisputeRecord, PaymentDisputeRepository } from "@/lib/disputes/paymentDisputeService";
import type { AdminDisputeReader } from "./adminCaseReviewService";

/**
 * Reuses Sprint 16's own `AgreementDisputeRepository`/`PaymentDisputeRepository` interfaces
 * unchanged (the real implementation just constructs `DrizzleAgreementDisputeRepository`/
 * `DrizzlePaymentDisputeRepository` directly — the exact same rows `AgreementDisputeService`/
 * `PaymentDisputeService` themselves read) — no new dispute storage, no new dispute logic. This
 * exists only because those services' own `getDispute`/`listDisputesForPayment` methods require the
 * caller be a resolvable agreement/payment party (`resolvePartyRole`), which an admin reviewer who is
 * not a party to the agreement is not — the repository layer has no such restriction, since
 * authorization is Sprint 18's own `AdminRoleService.requireCapability` concern here instead.
 */
export class AdminDisputeReaderAdapter implements AdminDisputeReader {
  constructor(
    private readonly agreementDisputes: Pick<AgreementDisputeRepository, "findById">,
    private readonly paymentDisputes: Pick<PaymentDisputeRepository, "findById">,
  ) {}

  async findAgreementDisputeById(id: string): Promise<AgreementDisputeRecord | null> {
    return this.agreementDisputes.findById(id);
  }

  async findPaymentDisputeById(id: string): Promise<PaymentDisputeRecord | null> {
    return this.paymentDisputes.findById(id);
  }
}
