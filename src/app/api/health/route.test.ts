import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/health", () => {
  it("returns 200 with an ok status payload", async () => {
    const response = await GET();
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      status: string;
      service: string;
      environment: string;
      timestamp: string;
      uptimeSeconds: number;
    };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("pay2pay");
    expect(typeof body.timestamp).toBe("string");
    expect(Number.isFinite(body.uptimeSeconds)).toBe(true);
  });
});
