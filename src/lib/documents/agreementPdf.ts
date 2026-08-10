import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { AgreementTerms, FeeAllocation, PartyRole, ProfileRef } from "@/lib/agreements/agreementService";
import type { PaymentFrequency, ScheduleItem } from "@/lib/agreements/schedule";

export interface AgreementPdfParty extends ProfileRef {
  displayName: string;
}

export interface AgreementPdfSignature {
  role: PartyRole;
  signerDisplayName: string;
  signedAt: Date;
  authMethod: string;
}

/**
 * Sprint 6 (docs/sprints/SPRINT_06_ElectronicSignatures_PDFRecords.md) required PDF content:
 * agreement number, parties, debt purpose, financial terms, payment schedule, fees, no-interest
 * terms, amendment terms, payment authorization placeholder, signatures, witness attestations
 * where applicable, agreement version, hash/reference.
 */
export interface AgreementPdfInput {
  agreementId: string;
  versionNumber: number;
  relationshipShape: "P2P" | "B2C" | "C2B" | "B2B";
  currency: string;
  creditor: AgreementPdfParty;
  debtor: AgreementPdfParty;
  terms: AgreementTerms;
  frequency: PaymentFrequency;
  feeAllocation: FeeAllocation;
  schedule: ScheduleItem[];
  signatures: AgreementPdfSignature[];
  documentHash: string;
}

function formatDollars(minorUnits: number, currency: string): string {
  return `${(minorUnits / 100).toFixed(2)} ${currency}`;
}

const PAGE_SIZE: [number, number] = [612, 792]; // US Letter, points
const MARGIN = 54;
const LINE_HEIGHT = 16;

/**
 * Renders the immutable agreement PDF. This sprint's "hash stability" requirement is satisfied by
 * generating exactly once per version — never regenerating (agreement_pdf's unique index on
 * agreement_version_id enforces this at the DB level, and SignatureService checks for an existing
 * row before calling this) — and by hashing the resulting bytes immediately and storing that hash
 * alongside them, so the recorded hash and the stored file can always be re-verified against each
 * other later. This function is not guaranteed to produce byte-identical output across independent
 * calls with the same input (pdf-lib does not promise that), so hash stability is a property of
 * "generate once, hash what you generated, never regenerate" — not of the renderer being a pure
 * function.
 */
export async function generateAgreementPdf(input: AgreementPdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage(PAGE_SIZE);
  let y = PAGE_SIZE[1] - MARGIN;

  function newPageIfNeeded(linesNeeded = 1): void {
    if (y - linesNeeded * LINE_HEIGHT < MARGIN) {
      page = doc.addPage(PAGE_SIZE);
      y = PAGE_SIZE[1] - MARGIN;
    }
  }

  function heading(text: string): void {
    newPageIfNeeded(2);
    page.drawText(text, { x: MARGIN, y, size: 13, font: boldFont, color: rgb(0, 0, 0) });
    y -= LINE_HEIGHT * 1.5;
  }

  function line(text: string): void {
    newPageIfNeeded();
    page.drawText(text, { x: MARGIN, y, size: 10, font, color: rgb(0.1, 0.1, 0.1) });
    y -= LINE_HEIGHT;
  }

  heading("PAY2PAY Repayment Agreement");
  line(`Agreement number: ${input.agreementId}`);
  line(`Agreement version: ${input.versionNumber}`);
  line(`Relationship type: ${input.relationshipShape}`);
  line(`Currency: ${input.currency}`);
  y -= LINE_HEIGHT / 2;

  heading("Parties");
  line(`Creditor: ${input.creditor.displayName} (${input.creditor.kind} profile ${input.creditor.id})`);
  line(`Debtor: ${input.debtor.displayName} (${input.debtor.kind} profile ${input.debtor.id})`);
  y -= LINE_HEIGHT / 2;

  heading("Debt purpose and financial terms");
  line(`Category: ${input.terms.category}`);
  line(`Description: ${input.terms.description}`);
  line(`Original amount: ${formatDollars(input.terms.originalAmountMinorUnits, input.currency)}`);
  line(`Previous payments: ${formatDollars(input.terms.previousPaymentsMinorUnits, input.currency)}`);
  line(`Current principal: ${formatDollars(input.terms.currentPrincipalMinorUnits, input.currency)}`);
  line(`Recurring installment: ${formatDollars(input.terms.installmentAmountMinorUnits, input.currency)} (${input.frequency})`);
  line(`Final payment: ${formatDollars(input.terms.finalPaymentMinorUnits, input.currency)}`);
  line(`Fee allocation: ${input.feeAllocation.replaceAll("_", " ")}`);
  y -= LINE_HEIGHT / 2;

  heading("No-interest terms");
  line("This agreement carries no interest, no compounding, and no percentage-based or");
  line("time-based late fees. Any disclosed fee is fixed and non-time-based.");
  y -= LINE_HEIGHT / 2;

  heading("Payment schedule");
  for (const item of input.schedule) {
    line(
      `${item.sequenceNumber === 0 ? "First payment" : `Installment ${item.sequenceNumber}`}: ` +
        `${formatDollars(item.amountMinorUnits, input.currency)} due ${item.dueDate}`,
    );
  }
  y -= LINE_HEIGHT / 2;

  heading("Early payoff, hardship, partial payment, and settlement terms");
  line(`Early payoff: ${input.terms.earlyPayoffTerms}`);
  line(`Hardship: ${input.terms.hardshipRules}`);
  line(`Partial payment: ${input.terms.partialPaymentRules}`);
  line(`Settlement: ${input.terms.settlementRules}`);
  y -= LINE_HEIGHT / 2;

  heading("Dispute procedure");
  line(input.terms.disputeProcedure);
  y -= LINE_HEIGHT / 2;

  heading("Amendment terms");
  line("This agreement may only be changed by mutual signature on a new agreement version.");
  line("No amendment has been made to this agreement as of this document's generation.");
  y -= LINE_HEIGHT / 2;

  heading("Payment authorization");
  line("Reserved for a later phase — no payment method has been authorized as part of");
  line("signing this agreement. Live payment processing is not implemented yet.");
  y -= LINE_HEIGHT / 2;

  heading("Signatures");
  for (const signature of input.signatures) {
    line(
      `${signature.role}: ${signature.signerDisplayName} — signed ${signature.signedAt.toISOString()} ` +
        `(${signature.authMethod})`,
    );
  }
  y -= LINE_HEIGHT / 2;

  heading("Witness attestations");
  line("None recorded. Witness attestations are a later-phase feature.");
  y -= LINE_HEIGHT / 2;

  heading("Document reference");
  line(`Terms hash: ${input.documentHash}`);

  return doc.save();
}

/** Tamper-evident hash of the final rendered PDF bytes, stored on agreement_pdf.document_hash. */
export function hashPdfContent(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
