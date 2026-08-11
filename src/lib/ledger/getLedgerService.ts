import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleLedgerAccountRepository } from "./drizzleLedgerAccountRepository";
import { DrizzleLedgerJournalEntryRepository } from "./drizzleLedgerJournalEntryRepository";
import { LedgerService } from "./ledgerService";

let cached: LedgerService | null = null;

export function getLedgerService(): LedgerService {
  if (!cached) {
    cached = new LedgerService({
      accounts: new DrizzleLedgerAccountRepository(),
      entries: new DrizzleLedgerJournalEntryRepository(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
