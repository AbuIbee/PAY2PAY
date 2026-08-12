import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzlePaymentAttemptRepository } from "@/lib/payments/drizzlePaymentAttemptRepository";
import { getLedgerService } from "@/lib/ledger/getLedgerService";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import {
  DrizzleIdentityVerificationReferenceReader,
  DrizzleMandateReferenceReader,
  DrizzleSignatureReferenceReader,
} from "./drizzleDisputeEvidenceReaders";
import { DrizzlePaymentDisputeRepository } from "./drizzlePaymentDisputeRepository";
import { PaymentDisputeService } from "./paymentDisputeService";

let cached: PaymentDisputeService | null = null;

export function getPaymentDisputeService(): PaymentDisputeService {
  if (!cached) {
    cached = new PaymentDisputeService({
      payments: new DrizzlePaymentAttemptRepository(),
      disputes: new DrizzlePaymentDisputeRepository(),
      ledger: getLedgerService(),
      profileOwners: new DrizzleProfileOwnerReader(),
      mandates: new DrizzleMandateReferenceReader(),
      signatures: new DrizzleSignatureReferenceReader(),
      identityVerifications: new DrizzleIdentityVerificationReferenceReader(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
