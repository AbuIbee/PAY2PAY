import "server-only";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import { getProfileAccessService } from "@/lib/profiles/getProfileAccessService";
import { DrizzleUserEmailReader } from "@/lib/staff/drizzleUserEmailReader";
import { getConsentService } from "./getConsentService";
import { DataExportService } from "./dataExportService";

let cached: DataExportService | null = null;

export function getDataExportService(): DataExportService {
  if (!cached) {
    cached = new DataExportService({
      profileAccess: getProfileAccessService(),
      agreements: getAgreementService(),
      consents: getConsentService(),
      accounts: new DrizzleUserEmailReader(),
    });
  }
  return cached;
}
