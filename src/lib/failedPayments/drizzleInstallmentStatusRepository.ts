import "server-only";
import { and, eq, ne } from "drizzle-orm";
import { getDb } from "@/db/client";
import { installmentScheduleItem } from "@/db/schema";
import type { InstallmentStatusRepository } from "./installmentStatusRepository";

export class DrizzleInstallmentStatusRepository implements InstallmentStatusRepository {
  /**
   * R09 corrective pass (Codex blocker 7 — failed-payment-workflow replay safety): `AND status <>
   * 'paid'` closes the exact regression Codex identified — a stale failed-attempt replay (an old
   * event resumed/retried after a LATER attempt for the same installment already succeeded) must
   * never regress an already-paid installment back to "past_due". A settled/paid installment is a
   * terminal, authoritative fact this call must never overwrite, no matter how out-of-order the
   * replay arrives.
   */
  async markPastDue(installmentScheduleItemId: string): Promise<void> {
    const db = getDb();
    await db
      .update(installmentScheduleItem)
      .set({ status: "past_due" })
      .where(and(eq(installmentScheduleItem.id, installmentScheduleItemId), ne(installmentScheduleItem.status, "paid")));
  }

  async markPaid(installmentScheduleItemId: string): Promise<void> {
    const db = getDb();
    await db
      .update(installmentScheduleItem)
      .set({ status: "paid" })
      .where(eq(installmentScheduleItem.id, installmentScheduleItemId));
  }

  /** See `InstallmentStatusRepository.markScheduled`'s own doc comment — the no-coordinator fallback path only; the real production path writes this under `FailedPaymentRetryCoordinator.coordinateSupersession`'s own row lock. */
  async markScheduled(installmentScheduleItemId: string): Promise<void> {
    const db = getDb();
    await db
      .update(installmentScheduleItem)
      .set({ status: "scheduled" })
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

  async findStatus(installmentScheduleItemId: string): Promise<string | null> {
    const db = getDb();
    const rows = await db
      .select({ status: installmentScheduleItem.status })
      .from(installmentScheduleItem)
      .where(eq(installmentScheduleItem.id, installmentScheduleItemId))
      .limit(1);
    return rows[0]?.status ?? null;
  }
}
