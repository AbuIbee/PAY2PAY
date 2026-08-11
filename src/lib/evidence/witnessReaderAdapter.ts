import type { EvidenceWitnessReader } from "./evidenceService";
import type { AgreementWitnessRepository } from "./witnessService";

/** Thin adapter so EvidenceService only ever sees a single read-only method, never the full write-capable AgreementWitnessRepository. */
export class WitnessReaderAdapter implements EvidenceWitnessReader {
  constructor(private readonly witnesses: AgreementWitnessRepository) {}

  async isActiveWitness(agreementId: string, userId: string): Promise<boolean> {
    const row = await this.witnesses.findByAgreementAndUser(agreementId, userId);
    return row !== null;
  }
}
