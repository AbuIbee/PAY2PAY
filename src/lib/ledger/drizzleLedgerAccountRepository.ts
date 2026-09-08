import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, type Database } from "@/db/client";
import { ledgerAccount } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { LedgerAccountRecord, LedgerAccountRepository, LedgerAccountType } from "./ledgerService";

type Row = typeof ledgerAccount.$inferSelect;

function toRecord(row: Row): LedgerAccountRecord {
  return { id: row.id, accountType: row.accountType, agreementId: row.agreementId, createdAt: row.createdAt };
}

export class DrizzleLedgerAccountRepository implements LedgerAccountRepository {
  /**
   * R07-style injectability: `db` defaults to the shared production singleton solely so
   * `*.postgres.test.ts` concurrency suites can hand this class a genuinely distinct connection.
   * Every production call site (`new DrizzleLedgerAccountRepository()`, no argument) is unaffected.
   */
  constructor(private readonly injectedDb: Database = getDb()) {}

  async findOrCreate(accountType: LedgerAccountType, agreementId: string): Promise<LedgerAccountRecord> {
    const db = this.injectedDb;
    const existing = await db
      .select()
      .from(ledgerAccount)
      .where(and(eq(ledgerAccount.accountType, accountType), eq(ledgerAccount.agreementId, agreementId)))
      .limit(1);
    if (existing[0]) return toRecord(existing[0]);

    await db.insert(ledgerAccount).values({ accountType, agreementId }).onConflictDoNothing();
    const rows = await db
      .select()
      .from(ledgerAccount)
      .where(and(eq(ledgerAccount.accountType, accountType), eq(ledgerAccount.agreementId, agreementId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new ConfigurationError("ledger_account findOrCreate failed to create or find a row");
    return toRecord(row);
  }
}
