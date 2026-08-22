import path from "node:path";
import type { NextConfig } from "next";

// SPRINT_19_FraudRisk_SecurityHardening: this repo previously had zero security headers configured
// anywhere (no middleware.ts, no headers() here, no headers block in vercel.json) — confirmed absent,
// not a false negative. The browser never talks to Supabase directly (no @supabase/supabase-js
// import in any client component — only server-side, for signed document-storage URLs), so
// connect-src/img-src only need to allow the app's own origin plus the Supabase storage domain for
// evidence-document previews/downloads.
//
// script-src/style-src keep 'unsafe-inline' rather than a nonce-based strict CSP: Next.js's App
// Router emits inline bootstrap scripts, and a nonce-based CSP requires new middleware wiring that
// would need full interactive browser QA across every page to verify nothing silently breaks —
// outside what this pass can safely verify. This is a real, documented residual gap (a future
// hardening pass), not a claim of a fully strict CSP. Every other real gap this header set closes
// (no CSP/HSTS/X-Content-Type-Options/Referrer-Policy/frame-ancestors at all) stands regardless.
const SUPABASE_STORAGE_ORIGIN = "https://*.supabase.co";

const contentSecurityPolicy = [
  "default-src 'self'",
  `connect-src 'self' ${SUPABASE_STORAGE_ORIGIN}`,
  `img-src 'self' data: blob: ${SUPABASE_STORAGE_ORIGIN}`,
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  turbopack: {
    // Pin the project root explicitly. Without this, Turbopack's upward
    // directory scan for a lockfile can notice one in a parent directory
    // outside this project and emit a "package-lock.json ignored" warning.
    // This setting silences that warning by declaring PAY2PAY itself as the
    // root — it does not read, reference, or depend on anything outside
    // this directory.
    root: path.resolve(__dirname),
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
