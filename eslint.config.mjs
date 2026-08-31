import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Preserved pre-redesign snapshot (see git history, "look and feel
    // updates" commit) — not live code, should not be linted/typechecked.
    "src-backup-before-redesign/**",
  ]),
  // scripts/**/*.cjs are intentionally standalone CommonJS Node scripts (run
  // directly via `node scripts/...cjs`, never bundled into the Next.js app),
  // so require() is the correct, valid import form for this file type —
  // not a violation of the ESM convention the rest of the codebase follows.
  // Scoped narrowly to this one file type only; every other rule (including
  // no-require-imports for .ts/.tsx) remains fully enforced everywhere else.
  {
    files: ["scripts/**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]);

export default eslintConfig;
