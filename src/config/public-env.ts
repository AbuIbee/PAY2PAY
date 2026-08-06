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
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

export function getPublicEnv(): PublicEnv {
  return publicEnvSchema.parse({
    NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
    NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
  });
}
