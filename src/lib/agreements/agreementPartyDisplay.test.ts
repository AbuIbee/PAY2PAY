import { describe, expect, it } from "vitest";
import { InMemoryProfileDisplayReader } from "@/lib/documents/testFakes";
import { resolveAgreementPartyDisplays, type PartyDisplayFields, type PartySnapshotReader } from "./agreementPartyDisplay";

/**
 * Item 2 (legacy agreements without snapshots): direct unit coverage of the ONE shared read every
 * on-screen/PDF caller uses for party identity. The mandatory rule under test: an old executed
 * agreement must never appear to change merely because a user later edits their profile, and no
 * historical structured identity (first/last name, email, city, state, ZIP, country) may ever be
 * fabricated for a pre-Decision-7 (legacy) agreement version that has no snapshot row.
 */
describe("resolveAgreementPartyDisplays — legacy vs snapshotted agreements", () => {
  const AGREEMENT = {
    id: "agreement-1",
    creditorProfileKind: "personal" as const,
    creditorProfileId: "creditor-profile-1",
    debtorProfileKind: "personal" as const,
    debtorProfileId: "debtor-profile-1",
  };

  const SNAPSHOT_FIELDS: PartyDisplayFields = {
    displayName: "Ada Lovelace",
    firstName: "Ada",
    lastName: "Lovelace",
    preferredEmail: "ada@example.com",
    city: "Austin",
    state: "TX",
    postalCode: "78701",
    country: "US",
  };

  class FakeSnapshotReader implements PartySnapshotReader {
    constructor(private readonly row: { creditor: PartyDisplayFields; debtor: PartyDisplayFields } | null) {}
    async getSnapshotForVersion(): Promise<{ creditor: PartyDisplayFields; debtor: PartyDisplayFields } | null> {
      return this.row;
    }
  }

  it("test A — a new snapshotted agreement version resolves from the immutable snapshot, source 'snapshot'", async () => {
    const partySnapshots = new FakeSnapshotReader({
      creditor: SNAPSHOT_FIELDS,
      debtor: { ...SNAPSHOT_FIELDS, displayName: "Grace Hopper", firstName: "Grace", lastName: "Hopper", preferredEmail: "grace@example.com" },
    });
    const profileDisplay = new InMemoryProfileDisplayReader();
    profileDisplay.set("personal", AGREEMENT.creditorProfileId, "SHOULD NEVER BE READ");

    const result = await resolveAgreementPartyDisplays(
      { agreement: AGREEMENT as never, version: { id: "version-1" } as never },
      { partySnapshots, profileDisplay },
    );

    expect(result.source).toBe("snapshot");
    expect(result.creditor.firstName).toBe("Ada");
    expect(result.creditor.preferredEmail).toBe("ada@example.com");
    expect(result.debtor.firstName).toBe("Grace");
  });

  it("test B — a legacy version with NO snapshot row resolves via a live display-name lookup, source 'legacy_live'", async () => {
    const partySnapshots = new FakeSnapshotReader(null); // no snapshot row exists for this version
    const profileDisplay = new InMemoryProfileDisplayReader();
    profileDisplay.set("personal", AGREEMENT.creditorProfileId, "Original Creditor Name");
    profileDisplay.set("personal", AGREEMENT.debtorProfileId, "Original Debtor Name");

    const result = await resolveAgreementPartyDisplays(
      { agreement: AGREEMENT as never, version: { id: "legacy-version-1" } as never },
      { partySnapshots, profileDisplay },
    );

    expect(result.source).toBe("legacy_live");
    expect(result.creditor.displayName).toBe("Original Creditor Name");
    expect(result.debtor.displayName).toBe("Original Debtor Name");
  });

  it("test C — after the profile is edited, the SAME legacy version's live-fallback display name changes (documented, pre-existing behavior) — but this is read-time-only and never persisted or written back onto any stored record", async () => {
    const partySnapshots = new FakeSnapshotReader(null);
    const profileDisplay = new InMemoryProfileDisplayReader();
    profileDisplay.set("personal", AGREEMENT.creditorProfileId, "Name At Execution Time");

    const before = await resolveAgreementPartyDisplays(
      { agreement: AGREEMENT as never, version: { id: "legacy-version-1" } as never },
      { partySnapshots, profileDisplay },
    );
    expect(before.creditor.displayName).toBe("Name At Execution Time");

    // The user edits their profile display name sometime later.
    profileDisplay.set("personal", AGREEMENT.creditorProfileId, "Name After Later Edit");

    const after = await resolveAgreementPartyDisplays(
      { agreement: AGREEMENT as never, version: { id: "legacy-version-1" } as never },
      { partySnapshots, profileDisplay },
    );
    expect(after.creditor.displayName).toBe("Name After Later Edit");
    expect(after.source).toBe("legacy_live"); // still explicitly flagged as the unreliable, live-only case
  });

  it("test D — the legacy fallback NEVER populates a single structured identity field, no matter what the underlying profile might contain — no historical name/email/address is ever fabricated", async () => {
    const partySnapshots = new FakeSnapshotReader(null);
    // PartyDisplayReader's own interface (agreementPartyDisplay.ts) exposes ONLY getDisplayName — no
    // email/address/first-or-last-name accessor exists at all for the legacy fallback to call, so
    // fabricating a structured field here isn't just avoided by convention, it's impossible by the
    // type the fallback branch is written against.
    const profileDisplay = new InMemoryProfileDisplayReader();
    profileDisplay.set("personal", AGREEMENT.creditorProfileId, "Someone Rich In Data Elsewhere");

    const result = await resolveAgreementPartyDisplays(
      { agreement: AGREEMENT as never, version: { id: "legacy-version-1" } as never },
      { partySnapshots, profileDisplay },
    );

    expect(result.creditor.firstName).toBeNull();
    expect(result.creditor.lastName).toBeNull();
    expect(result.creditor.preferredEmail).toBeNull();
    expect(result.creditor.city).toBeNull();
    expect(result.creditor.state).toBeNull();
    expect(result.creditor.postalCode).toBeNull();
    expect(result.creditor.country).toBeNull();
    expect(result.debtor.firstName).toBeNull();
    expect(result.debtor.preferredEmail).toBeNull();
  });
});
