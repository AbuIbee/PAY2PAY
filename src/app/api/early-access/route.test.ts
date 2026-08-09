import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { resetRateLimits } from "@/lib/rate-limit";
import { InMemoryEarlyAccessLeadRepository } from "@/lib/early-access/testFakes";
import { createEarlyAccessHandler } from "./route";

const URL = "http://localhost/api/early-access";

function postJson(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(URL, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

const validIndividual = {
  name: "Jordan Rivera",
  email: "jordan@example.com",
  accountType: "individual",
  state: "CA",
  intendedUse: "Repaying a friend for a shared apartment deposit.",
  expectedAgreementsPerMonth: 1,
};

const validBusiness = {
  name: "Sam Lee",
  email: "sam@example-biz.com",
  accountType: "business",
  businessName: "Lee Repair Co.",
  state: "TX",
  intendedUse: "Installment plans for completed repair jobs.",
  expectedAgreementsPerMonth: 12,
};

describe("POST /api/early-access", () => {
  let repository: InMemoryEarlyAccessLeadRepository;

  beforeEach(() => {
    resetRateLimits();
    repository = new InMemoryEarlyAccessLeadRepository();
  });

  function handlerFor(repo = repository) {
    return withErrorHandling("early_access_submit", createEarlyAccessHandler(repo));
  }

  it("accepts a valid individual submission and returns 201", async () => {
    const response = await handlerFor()(postJson(validIndividual));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { status: string; id: string };
    expect(body.status).toBe("ok");
    expect(body.id).toBeTruthy();
    expect(repository.byEmail.get("jordan@example.com")?.businessName).toBeNull();
  });

  it("accepts a valid business submission and stores the business name", async () => {
    const response = await handlerFor()(postJson(validBusiness));
    expect(response.status).toBe(201);
    expect(repository.byEmail.get("sam@example-biz.com")?.businessName).toBe("Lee Repair Co.");
  });

  it("rejects a business submission with no business name", async () => {
    const { businessName, ...withoutBusinessName } = validBusiness;
    void businessName;
    const response = await handlerFor()(postJson(withoutBusinessName));
    expect(response.status).toBe(400);
  });

  it("rejects a malformed email", async () => {
    const response = await handlerFor()(postJson({ ...validIndividual, email: "not-an-email" }));
    expect(response.status).toBe(400);
  });

  it("rejects an invalid state code", async () => {
    const response = await handlerFor()(postJson({ ...validIndividual, state: "ZZ" }));
    expect(response.status).toBe(400);
  });

  it("never persists a bank account, SSN, EIN, card, or ID field even if sent", async () => {
    const response = await handlerFor()(
      postJson({
        ...validIndividual,
        bankAccountNumber: "000123456789",
        routingNumber: "021000021",
        ssn: "123-45-6789",
        governmentId: "X1234567",
        cardNumber: "4111111111111111",
      }),
    );
    expect(response.status).toBe(201);
    const stored = repository.byEmail.get("jordan@example.com") as unknown as Record<
      string,
      unknown
    >;
    expect(stored).not.toHaveProperty("bankAccountNumber");
    expect(stored).not.toHaveProperty("routingNumber");
    expect(stored).not.toHaveProperty("ssn");
    expect(stored).not.toHaveProperty("governmentId");
    expect(stored).not.toHaveProperty("cardNumber");
  });

  it("silently accepts but does not store a honeypot-triggered submission", async () => {
    const response = await handlerFor()(
      postJson({ ...validIndividual, email: "bot@example.com", website: "http://spam.example" }),
    );
    expect(response.status).toBe(201);
    expect(repository.byEmail.has("bot@example.com")).toBe(false);
  });

  it("upserts by email instead of creating a duplicate row", async () => {
    await handlerFor()(postJson(validIndividual));
    await handlerFor()(postJson({ ...validIndividual, notes: "Following up again." }));
    expect(repository.byEmail.size).toBe(1);
    expect(repository.byEmail.get("jordan@example.com")?.notes).toBe("Following up again.");
  });

  it("rate-limits repeated submissions from the same IP", async () => {
    const handler = handlerFor();
    const headers = { "x-forwarded-for": "203.0.113.9" };
    for (let i = 0; i < 5; i += 1) {
      const response = await handler(
        postJson({ ...validIndividual, email: `rl-${i}@example.com` }, headers),
      );
      expect(response.status).toBe(201);
    }
    const blocked = await handler(
      postJson({ ...validIndividual, email: "rl-blocked@example.com" }, headers),
    );
    expect(blocked.status).toBe(429);
  });
});
