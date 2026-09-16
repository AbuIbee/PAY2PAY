import { z } from "zod";

/**
 * Client-safe environment schema. Only `NEXT_PUBLIC_*` variables belong
 * here — Next.js inlines those into the browser bundle at build time, so
 * nothing in this file (or anything it validates) may be treated as a
 * secret. This module deliberately does NOT import "server-only" and
 * deliberately does NOT import anything from ./env.ts, keeping the two
 * module graphs fully separate.
 */
const publicEnvSchema = z.object({
  NEXT_PUBLIC_APP_NAME: z.string().min(1).default("PAY2PAY"),
  NEXT_PUBLIC_APP_ENV: z
    .enum(["development", "test", "staging", "production"])
    .default("development"),
  /**
   * PAID2YOU — B0-D ADYEN PHASE 2 (bank-account collection/tokenization): Adyen's own "client key" —
   * explicitly designed by Adyen to be safe for browser exposure (origin-restricted in the Adyen
   * Customer Area, carries no secret authority of its own; distinct from ADYEN_API_KEY, which never
   * appears here or anywhere client-side). Required by `@adyen/adyen-web` to initialize the bank-
   * account collection Component against a server-created session. Optional here (undefined, not a
   * placeholder, when unset) — the add-bank page itself fails closed to a controlled "unavailable"
   * state rather than attempting to mount a Component with no client key (see item 7/6's own
   * requirement: "Missing required configuration → fail closed").
   */
  NEXT_PUBLIC_ADYEN_CLIENT_KEY: z.string().min(1).optional(),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

export function getPublicEnv(): PublicEnv {
  return publicEnvSchema.parse({
    NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
    NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
    NEXT_PUBLIC_ADYEN_CLIENT_KEY: process.env.NEXT_PUBLIC_ADYEN_CLIENT_KEY,
  });
}
