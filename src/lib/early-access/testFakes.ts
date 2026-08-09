import { randomUUID } from "node:crypto";
import type {
  EarlyAccessLeadInput,
  EarlyAccessLeadRecord,
  EarlyAccessLeadRepository,
} from "./earlyAccessLeadRepository";

/**
 * Test-only in-memory double, mirroring src/lib/auth/testFakes.ts's pattern.
 * Not imported by any production code path.
 */
export class InMemoryEarlyAccessLeadRepository implements EarlyAccessLeadRepository {
  byEmail = new Map<string, EarlyAccessLeadInput & EarlyAccessLeadRecord>();

  async upsertByEmail(input: EarlyAccessLeadInput): Promise<EarlyAccessLeadRecord> {
    const existing = this.byEmail.get(input.email);
    const id = existing?.id ?? randomUUID();
    this.byEmail.set(input.email, { ...input, id });
    return { id };
  }
}
