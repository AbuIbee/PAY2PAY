/**
 * Sprint 18B: RelationshipService.getRelationship never resolves a
 * counterparty's display name from raw individualProfileId/organizationId —
 * no route in this codebase exposes another party's profile name (by
 * design: AgreementDetail has the identical gap, see
 * docs/SPRINT_18B_UI_INTEGRATION_MATRIX.md's Connections section). Rather
 * than show a raw UUID ("no raw IDs as primary labels" — the 18B prompt's
 * own explicit rule), every participant is labeled by role + identity kind
 * + "You" when it's the caller's own participation. This is an honest,
 * flagged limitation, not a fake name.
 */
export interface ParticipantLike {
  id: string;
  individualProfileId: string | null;
  organizationId: string | null;
  role: "creditor" | "debtor";
  representedByUserId: string | null;
}

export function participantLabel(participant: ParticipantLike, myUserId: string | null): string {
  const kind = participant.individualProfileId ? "Individual" : "Business";
  const role = participant.role === "creditor" ? "Creditor" : "Debtor";
  const isMe = myUserId !== null && participant.representedByUserId === myUserId;
  return isMe ? `You (${role})` : `${kind} counterparty (${role})`;
}

export function roleLabel(role: "creditor" | "debtor"): string {
  return role === "creditor" ? "Creditor" : "Debtor";
}
