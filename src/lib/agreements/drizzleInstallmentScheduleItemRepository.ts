import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { installmentScheduleItem } from "@/db/schema";
import type { InstallmentScheduleItemRepository } from "./agreementService";
import type { ScheduleItem } from "./schedule";

export class DrizzleInstallmentScheduleItemRepository implements InstallmentScheduleItemRepository {
  async replaceForVersion(versionId: string, items: ScheduleItem[]): Promise<void> {
    const db = getDb();
    await db.transaction(async (tx) => {
      await tx.delete(installmentScheduleItem).where(eq(installmentScheduleItem.agreementVersionId, versionId));
      if (items.length === 0) return;
      await tx.insert(installmentScheduleItem).values(
        items.map((item) => ({
          agreementVersionId: versionId,
          sequenceNumber: item.sequenceNumber,
          dueDate: item.dueDate,
          amountMinorUnits: item.amountMinorUnits,
        })),
      );
    });
  }

  async listForVersion(versionId: string): Promise<ScheduleItem[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(installmentScheduleItem)
      .where(eq(installmentScheduleItem.agreementVersionId, versionId))
      .orderBy(installmentScheduleItem.sequenceNumber);
    return rows.map((row) => ({
      sequenceNumber: row.sequenceNumber,
      dueDate: row.dueDate,
      amountMinorUnits: row.amountMinorUnits,
    }));
  }
}
