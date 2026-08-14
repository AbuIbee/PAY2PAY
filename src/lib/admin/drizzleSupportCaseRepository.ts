import "server-only";
import { and, eq, ne } from "drizzle-orm";
import { getDb } from "@/db/client";
import { supportCase } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { SupportCaseRecord, SupportCaseRepository, SupportCaseStatus } from "./supportCaseService";

type Row = typeof supportCase.$inferSelect;

function toRecord(row: Row): SupportCaseRecord {
  return {
    id: row.id,
    subjectUserId: row.subjectUserId,
    openedByUserId: row.openedByUserId,
    category: row.category,
    summary: row.summary,
    status: row.status as SupportCaseStatus,
    resolutionNotes: row.resolutionNotes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    resolvedAt: row.resolvedAt,
    closedAt: row.closedAt,
  };
}

export class DrizzleSupportCaseRepository implements SupportCaseRepository {
  async insert(input: { subjectUserId: string; openedByUserId: string | null; category: string | null; summary: string }): Promise<SupportCaseRecord> {
    const db = getDb();
    const [row] = await db.insert(supportCase).values(input).returning();
    if (!row) throw new ConfigurationError("support_case insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<SupportCaseRecord | null> {
    const db = getDb();
    const rows = await db.select().from(supportCase).where(eq(supportCase.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listForUser(subjectUserId: string): Promise<SupportCaseRecord[]> {
    const db = getDb();
    const rows = await db.select().from(supportCase).where(eq(supportCase.subjectUserId, subjectUserId));
    return rows.map(toRecord);
  }

  async listOpen(): Promise<SupportCaseRecord[]> {
    const db = getDb();
    const rows = await db.select().from(supportCase).where(and(ne(supportCase.status, "closed"), ne(supportCase.status, "resolved")));
    return rows.map(toRecord);
  }

  async updateStatus(id: string, status: SupportCaseStatus, resolutionNotes: string | null): Promise<SupportCaseRecord> {
    const db = getDb();
    const now = new Date();
    const [row] = await db
      .update(supportCase)
      .set({
        status,
        resolutionNotes,
        updatedAt: now,
        resolvedAt: status === "resolved" ? now : undefined,
        closedAt: status === "closed" ? now : undefined,
      })
      .where(eq(supportCase.id, id))
      .returning();
    if (!row) throw new ConfigurationError("support_case updateStatus found no row");
    return toRecord(row);
  }
}
