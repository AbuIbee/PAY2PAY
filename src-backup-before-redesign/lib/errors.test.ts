import { describe, expect, it } from "vitest";
import { AppError, ConfigurationError, ValidationError, toSafeErrorResponse } from "./errors";

describe("toSafeErrorResponse", () => {
  it("passes through an AppError's own message, code, and status", () => {
    const error = new ValidationError("amount must be positive");
    const response = toSafeErrorResponse(error);
    expect(response).toEqual({
      message: "amount must be positive",
      code: "VALIDATION_ERROR",
      statusCode: 400,
    });
  });

  it("uses AppError defaults when no options are given", () => {
    const error = new AppError("boom");
    const response = toSafeErrorResponse(error);
    expect(response.code).toBe("INTERNAL_ERROR");
    expect(response.statusCode).toBe(500);
  });

  it("never leaks a non-AppError's message (e.g. a raw database error)", () => {
    const dbError = new Error("password authentication failed for user \"admin\"");
    const response = toSafeErrorResponse(dbError);
    expect(response.message).toBe("An unexpected error occurred.");
    expect(response.message).not.toContain("password");
    expect(response.statusCode).toBe(500);
  });

  it("marks configuration errors as non-operational", () => {
    const error = new ConfigurationError("missing required config");
    expect(error.isOperational).toBe(false);
  });
});
