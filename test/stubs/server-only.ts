// Test-only stub for the "server-only" package. Next.js's own bundler
// no-ops this import when building server code and only makes it throw for
// client bundles; Vitest has no such distinction (it always runs in Node),
// so this alias (see vitest.config.ts) reproduces the "server code is fine"
// half of that behavior for tests. Real client/server boundary enforcement
// still happens for real via `next build` (see README "Secrets and the
// client bundle").
export {};
