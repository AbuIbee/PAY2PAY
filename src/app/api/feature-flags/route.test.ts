import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("GET /api/feature-flags", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns liveCardIssuanceEnabled: false by default, with no auth required", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { liveCardIssuanceEnabled: boolean };
    expect(body).toEqual({ liveCardIssuanceEnabled: false });
  });

  it("reflects the FEATURE_LIVE_CARD_ISSUANCE_ENABLED env override", async () => {
    vi.stubEnv("FEATURE_LIVE_CARD_ISSUANCE_ENABLED", "true");
    const response = await GET();
    const body = (await response.json()) as { liveCardIssuanceEnabled: boolean };
    expect(body).toEqual({ liveCardIssuanceEnabled: true });
  });
});
