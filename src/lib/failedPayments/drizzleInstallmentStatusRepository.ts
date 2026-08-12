import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { installmentScheduleItem } from "@/db/schema";
import type { InstallmentStatusRepository } from "./installmentStatusRepository";

export class DrizzleInstallmentStatusRepository implements InstallmentStatusRepository {
  async markPastDue(installmentScheduleItemId: string): Promise<void> {
    const db = getDb();
    await db
      .update(installmentScheduleItem)
      .set({ status: "past_due" })
      .where(eq(installmentScheduleItem.id, installmentScheduleItemId));
  }

  async markPaid(installmentScheduleItemId: string): Promise<void> {
    const db = getDb();
    await db
      .update(installmentScheduleItem)
      .set({ status: "paid" })
      .where(eq(installmentScheduleItem.id, installmentScheduleItemId));
  }

  async findDueDate(installmentScheduleItemId: string): Promise<string | null> {
    const db = getDb();
    const rows = await db
      .select({ dueDate: installmentScheduleItem.dueDate })
      .from(installmentScheduleItem)
      .where(eq(installmentScheduleItem.id, installmentScheduleItemId))
      .limit(1);
    return rows[0]?.dueDate ?? null;
  }

  async updateDueDate(installmentScheduleItemId: string, dueDate: string): Promise<void> {
    const db = getDb();
    await db.update(installmentScheduleItem).set({ dueDate }).where(eq(installmentScheduleItem.id, installmentScheduleItemId));
  }
}
