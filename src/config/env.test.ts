import { describe, expect, it } from "vitest";
import { EnvironmentValidationError, parseServerEnv } from "./env";

const validEnv = {
  NODE_ENV: "test",
  APP_ENV: "test",
  DATABASE_URL: "postgres://user:pass@localhost:5432/pay2pay",
  AUDIT_HASH_SECRET: "a-sufficiently-long-secret-value",
  AUTH_PASSWORD_PEPPER: "a-sufficiently-long-pepper-value",
};

function omit<T extends Record<string, unknown>>(obj: T, key: keyof T): Partial<T> {
  const clone: Partial<T> = { ...obj };
  delete clone[key];
  return clone;
}

describe("parseServerEnv", () => {
  it("accepts a fully-populated, valid environment", () => {
    const env = parseServerEnv(validEnv);
    expect(env.DATABASE_URL).toBe(validEnv.DATABASE_URL);
    expect(env.AUDIT_HASH_SECRET).toBe(validEnv.AUDIT_HASH_SECRET);
    expect(env.APP_ENV).toBe("test");
  });

  it("applies safe defaults for NODE_ENV/APP_ENV when omitted", () => {
    const env = parseServerEnv({
      DATABASE_URL: validEnv.DATABASE_URL,
      AUDIT_HASH_SECRET: validEnv.AUDIT_HASH_SECRET,
      AUTH_PASSWORD_PEPPER: validEnv.AUTH_PASSWORD_PEPPER,
    });
    expect(env.NODE_ENV).toBe("development");
    expect(env.APP_ENV).toBe("development");
  });

  it("rejects a missing DATABASE_URL", () => {
    expect(() => parseServerEnv(omit(validEnv, "DATABASE_URL"))).toThrow(
      EnvironmentValidationError,
    );
  });

  it("rejects a missing AUDIT_HASH_SECRET", () => {
    expect(() => parseServerEnv(omit(validEnv, "AUDIT_HASH_SECRET"))).toThrow(
      EnvironmentValidationError,
    );
  });

  it("rejects an AUDIT_HASH_SECRET that is too short", () => {
    expect(() =>
      parseServerEnv({ ...validEnv, AUDIT_HASH_SECRET: "short" }),
    ).toThrow(EnvironmentValidationError);
  });

  it("rejects a missing AUTH_PASSWORD_PEPPER", () => {
    expect(() => parseServerEnv(omit(validEnv, "AUTH_PASSWORD_PEPPER"))).toThrow(
      EnvironmentValidationError,
    );
  });

  it("rejects an AUTH_PASSWORD_PEPPER that is too short", () => {
    expect(() =>
      parseServerEnv({ ...validEnv, AUTH_PASSWORD_PEPPER: "short" }),
    ).toThrow(EnvironmentValidationError);
  });

  it("rejects a DATABASE_URL that isn't a postgres connection string", () => {
    expect(() =>
      parseServerEnv({ ...validEnv, DATABASE_URL: "mysql://localhost/db" }),
    ).toThrow(EnvironmentValidationError);
  });

  it("falls back to POSTGRES_URL when DATABASE_URL is unset", () => {
    const withoutDatabaseUrl = omit(validEnv, "DATABASE_URL");
    const env = parseServerEnv({
      ...withoutDatabaseUrl,
      POSTGRES_URL: "postgres://user:pass@localhost:5432/vercel-postgres",
    });
    expect(env.DATABASE_URL).toBe("postgres://user:pass@localhost:5432/vercel-postgres");
  });

  it("prefers DATABASE_URL over POSTGRES_URL when both are set", () => {
    const env = parseServerEnv({
      ...validEnv,
      POSTGRES_URL: "postgres://user:pass@localhost:5432/should-be-ignored",
    });
    expect(env.DATABASE_URL).toBe(validEnv.DATABASE_URL);
  });

  it("rejects an empty environment entirely", () => {
    expect(() => parseServerEnv({})).toThrow(EnvironmentValidationError);
  });

  it("defaults EMAIL_FROM_NAME to PAY2PAY and EMAIL_DELIVERY_ENABLED to true when unset", () => {
    const env = parseServerEnv(validEnv);
    expect(env.EMAIL_FROM_NAME).toBe("PAY2PAY");
    expect(env.EMAIL_DELIVERY_ENABLED).toBe(true);
    expect(env.RESEND_API_KEY).toBeUndefined();
    expect(env.EMAIL_FROM_ADDRESS).toBeUndefined();
  });

  it("coerces EMAIL_DELIVERY_ENABLED=\"false\" to the boolean false (the kill switch)", () => {
    const env = parseServerEnv({ ...validEnv, EMAIL_DELIVERY_ENABLED: "false" });
    expect(env.EMAIL_DELIVERY_ENABLED).toBe(false);
  });

  it("rejects an EMAIL_FROM_ADDRESS that isn't a valid email", () => {
    expect(() => parseServerEnv({ ...validEnv, EMAIL_FROM_ADDRESS: "not-an-email" })).toThrow(EnvironmentValidationError);
  });

  it("PRSprint 14 production defect fix: rejects a localhost APP_URL when APP_ENV is production", () => {
    expect(() => parseServerEnv({ ...validEnv, APP_ENV: "production", APP_URL: "http://localhost:3000" })).toThrow(EnvironmentValidationError);
    expect(() => parseServerEnv({ ...validEnv, APP_ENV: "production", APP_URL: "http://127.0.0.1:3000" })).toThrow(EnvironmentValidationError);
  });

  it("the localhost-in-production error names APP_URL specifically", () => {
    expect.assertions(1);
    try {
      parseServerEnv({ ...validEnv, APP_ENV: "production", APP_URL: "http://localhost:3000" });
    } catch (error) {
      expect((error as Error).message).toContain("APP_URL");
    }
  });

  it("accepts the production default (no APP_URL override) precisely because it's still localhost — same failure mode as an explicit localhost value", () => {
    expect(() => parseServerEnv({ ...validEnv, APP_ENV: "production" })).toThrow(EnvironmentValidationError);
  });

  it("accepts a real production APP_URL", () => {
    const env = parseServerEnv({ ...validEnv, APP_ENV: "production", APP_URL: "https://paid2you.com" });
    expect(env.APP_URL).toBe("https://paid2you.com");
  });

  it("Agreement Lifecycle V2 UAT fix: falls back to https://VERCEL_URL when APP_URL isn't explicitly set", () => {
    const env = parseServerEnv({ ...validEnv, VERCEL_URL: "pay-2-abc123-pay2-pay.vercel.app" });
    expect(env.APP_URL).toBe("https://pay-2-abc123-pay2-pay.vercel.app");
  });

  it("prefers an explicit APP_URL over VERCEL_URL when both are set", () => {
    const env = parseServerEnv({ ...validEnv, APP_URL: "https://paid2you.com", VERCEL_URL: "pay-2-abc123-pay2-pay.vercel.app" });
    expect(env.APP_URL).toBe("https://paid2you.com");
  });

  it("still falls back to the localhost default when neither APP_URL nor VERCEL_URL is set (genuine local dev)", () => {
    const env = parseServerEnv(validEnv);
    expect(env.APP_URL).toBe("http://localhost:3000");
  });

  it("an unconfigured Preview deployment (APP_ENV defaults to development, VERCEL_URL present) resolves to the real deployment origin, never localhost", () => {
    const env = parseServerEnv({ ...validEnv, APP_ENV: "development", VERCEL_URL: "pay-2-pay-git-some-branch-pay2-pay.vercel.app" });
    expect(env.APP_URL).toBe("https://pay-2-pay-git-some-branch-pay2-pay.vercel.app");
  });

  it("does not reject a localhost APP_URL outside production (development/test/staging)", () => {
    for (const appEnv of ["development", "test", "staging"] as const) {
      expect(() => parseServerEnv({ ...validEnv, APP_ENV: appEnv, APP_URL: "http://localhost:3000" })).not.toThrow();
    }
  });

  it("includes the offending field path in the error message", () => {
    expect.assertions(2);
    try {
      parseServerEnv(omit(validEnv, "DATABASE_URL"));
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentValidationError);
      expect((error as Error).message).toContain("DATABASE_URL");
    }
  });
});
