#!/usr/bin/env node
/**
 * PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION, requirement #12 / REM-001 (dependency-graph rewrite): a
 * CI regression gate that fails if sandbox financial/KYC/card-issuing provider functionality is ever
 * REACHABLE from actual production runtime. Runs on every push/PR via `npm run test:tooling` (this
 * file's own *.test.mjs is picked up by that glob) and directly via `npm run check-no-sandbox-runtime`.
 *
 * REM-001 correction: the previous version was a per-file regex scanner that excluded `test-support/**`
 * and `*testFakes.ts(x)` by skipping their CONTENT entirely, before it was ever read. Codex demonstrated
 * the exact bypass this created: an excluded file can re-export a prohibited sandbox provider under an
 * innocuous name, and a production file importing that intermediary escapes detection, because neither
 * the intermediary's own violation (never scanned — its content was skipped) nor the production
 * consumer's import line (which never mentions "sandbox") is ever flagged.
 *
 * This version does not scan files in isolation at all. It builds the ACTUAL production module
 * dependency graph — starting from real application entry points (Next.js routes/pages/layouts under
 * src/app/**, production configuration under src/config/**, next.config.ts), parsing every reachable
 * file's real imports, re-exports, export-all declarations, and dynamic import()/require() calls with the TypeScript compiler API
 * (resolving relative paths AND the project's own `@/*` tsconfig path alias, exactly as the real
 * TypeScript compiler and Next.js bundler do), and traverses that graph. A file is EXCLUDED from being
 * a traversal ROOT if it is a test file — but is NEVER excluded from being traversed INTO once some
 * production root's import chain actually reaches it, regardless of what directory it lives in or what
 * its filename is. The prohibited sandbox provider implementation files are matched by their resolved
 * file identity (not by class name, not by directory name) — so this holds even if the sandbox class
 * itself is renamed, re-exported under a different name, or reached through several layers of
 * intermediary modules, including ones that live inside `src/test-support/` or a `*testFakes.ts(x)`
 * file.
 *
 * Three checks remain simple per-file content scans (not graph/reachability-dependent, since they are
 * about what a file's OWN text contains, not what it imports): a rogue `class Sandbox*Provider`
 * declaration outside `src/test-support/`, a reference to the retired `/api/admin/sandbox` route, and
 * `PAYMENT_PROVIDER`/`KYC_PROVIDER`/`CARD_ISSUING_PROVIDER` literally assigned the string `"sandbox"` in
 * application code (never inside a `*.test.ts(x)` fixture, which may legitimately assert that value is
 * REJECTED). These run over every production-reachable file discovered by the graph traversal (never
 * over excluded-directory content that production never actually reaches).
 */
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.join(__dirname, "..");
export const srcDir = path.join(projectRoot, "src");

/**
 * The three retired sandbox provider implementation files — prohibited by FILE IDENTITY (their
 * canonical location relative to ANY `test-support/` directory), matched after resolution, regardless
 * of what the file's own class is named today. Deliberately a RELATIVE path-suffix pattern, not an
 * absolute path list computed from this project's own `srcDir` — an absolute list would only ever
 * match this real repository's own files, silently failing to recognize the equivalent fixture files a
 * disposable test constructs under its own temporary directory (this is itself covered by this file's
 * own regression test suite — a self-check that this constant generalizes correctly).
 */
const CANONICAL_SANDBOX_PROVIDER_PATH_PATTERN = /test-support[\/\\]payments[\/\\]sandboxPaymentProvider\.tsx?$|test-support[\/\\]kyc[\/\\]sandboxKycProvider\.tsx?$|test-support[\/\\]cards[\/\\]sandboxCardIssuingProvider\.tsx?$/;

const SANDBOX_CLASS_DECLARATION_PATTERN = /\bclass\s+Sandbox(?:PaymentProvider|KycProvider|CardIssuingProvider)\b/;
const RETIRED_ADMIN_SANDBOX_ROUTE_PATTERN = /\/api\/admin\/sandbox\b/;
const FORBIDDEN_PROVIDER_LITERAL_PATTERN = /(PAYMENT_PROVIDER|KYC_PROVIDER|CARD_ISSUING_PROVIDER)\s*[:=]\s*["']sandbox["']/;

export function isTestFile(relativeOrAbsolutePath) {
  const normalized = relativeOrAbsolutePath.split(path.sep).join("/");
  return /\.test\.tsx?$/.test(normalized);
}

/** Loads the real project tsconfig.json (or a caller-supplied one, for fixture-driven tests) into `ts.CompilerOptions`, so path-alias resolution (e.g. `@/*`) matches the real compiler exactly. */
export function loadCompilerOptions(tsconfigDir) {
  const configPath = ts.findConfigFile(tsconfigDir, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    // Fixture directories without their own tsconfig.json still need SOME options to resolve a "@/*"
    // alias against their own root — mirrors this project's actual convention.
    return { baseUrl: tsconfigDir, paths: { "@/*": ["./*"] }, moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true };
  }
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
  return parsed.options;
}

function scriptKindForFile(filePath) {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".ts") || filePath.endsWith(".mts") || filePath.endsWith(".cts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS; // .js/.jsx/.mjs/.cjs
}

/**
 * Extracts every static import, re-export (`export {...} from`), export-all (`export * from`), literal
 * dynamic `import("...")`, and literal `require("...")` module specifier from a file's real AST — never
 * a regex over the raw text. Returns `{ specifier: string | null, kind, node }[]` — `specifier` is
 * `null` for a dynamic import()/require() whose argument is NOT a string literal (cannot be resolved
 * statically; not treated as a violation, since it is not necessarily a local path at all).
 */
export function extractModuleReferences(filePath, text) {
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKindForFile(filePath));
  const refs = [];
  function visit(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      refs.push({ specifier: node.moduleSpecifier.text, kind: "import" });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      refs.push({ specifier: node.moduleSpecifier.text, kind: node.exportClause ? "re-export" : "export-all" });
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          refs.push({ specifier: arg.text, kind: isDynamicImport ? "dynamic-import" : "require" });
        } else {
          refs.push({ specifier: null, kind: isDynamicImport ? "dynamic-import-unresolvable" : "require-unresolvable" });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return refs;
}

/**
 * Non-code assets (stylesheets, images, fonts, etc.) that Next.js's own bundler resolves via a webpack/
 * turbopack loader, never via the TypeScript compiler — `ts.resolveModuleName` has no way to resolve
 * these and never needs to: they cannot possibly contain a JS/TS import of a sandbox provider, so they
 * are treated as external (skipped, never traversed, never flagged as "unresolved") rather than
 * producing a false-positive `unresolved-local-import` violation.
 */
const NON_CODE_ASSET_EXTENSION_PATTERN = /\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|eot|otf|mp4|webm|pdf|txt|md)$/i;

/** `{ kind: "external" }` for a bare package specifier or non-code asset (never traversed — not part of this repo's own source-code graph), `{ kind: "local", file }` for a resolved local file, or `{ kind: "unresolved" }` when a local-looking specifier cannot be resolved to a real file at all. */
export function resolveSpecifier(specifier, importingFile, compilerOptions) {
  const looksLocal = specifier.startsWith(".") || specifier.startsWith("/") || (compilerOptions.paths && Object.keys(compilerOptions.paths).some((p) => specifier.startsWith(p.replace(/\*$/, ""))));
  if (!looksLocal) return { kind: "external" };
  if (NON_CODE_ASSET_EXTENSION_PATTERN.test(specifier)) return { kind: "external" };
  const result = ts.resolveModuleName(specifier, importingFile, { ...compilerOptions, allowJs: true, resolveJsonModule: false }, ts.sys);
  if (result.resolvedModule && existsSync(result.resolvedModule.resolvedFileName)) {
    return { kind: "local", file: path.resolve(result.resolvedModule.resolvedFileName) };
  }
  return { kind: "unresolved" };
}

function isProhibitedSandboxTarget(filePath, text) {
  if (CANONICAL_SANDBOX_PROVIDER_PATH_PATTERN.test(filePath)) return true;
  // Defense-in-depth: a NEW file anywhere declaring one of these exact class names is also prohibited,
  // even if it happens not to be one of the three canonical paths above (e.g. a duplicate/copy).
  return SANDBOX_CLASS_DECLARATION_PATTERN.test(text) && !isUnderTestSupport(filePath);
}

export function isUnderTestSupport(filePath) {
  return filePath.split(path.sep).join("/").includes("/test-support/");
}

const DEFAULT_SANDBOX_CONTENT_RULES = [
  {
    category: "retired-admin-sandbox-route-reference",
    test: (text) => RETIRED_ADMIN_SANDBOX_ROUTE_PATTERN.test(text),
    detail: (text) => text.match(RETIRED_ADMIN_SANDBOX_ROUTE_PATTERN)[0],
  },
  {
    category: "forbidden-provider-literal-sandbox",
    test: (text, file) => !isTestFile(file) && FORBIDDEN_PROVIDER_LITERAL_PATTERN.test(text),
    detail: (text) => text.match(FORBIDDEN_PROVIDER_LITERAL_PATTERN)[0],
  },
  {
    category: "sandbox-provider-class-declaration",
    test: (text, file) => !isUnderTestSupport(file) && SANDBOX_CLASS_DECLARATION_PATTERN.test(text),
    detail: (text) => text.match(SANDBOX_CLASS_DECLARATION_PATTERN)[0],
  },
];

/**
 * Walks the real application source tree to find production ROOTS: every non-test `.ts`/`.tsx` file
 * under `src/app/**` (Next.js routes, pages, layouts, API route handlers, loading/error boundaries —
 * everything under App Router is a real build/runtime entry point), every non-test file directly under
 * `src/config/**` (production configuration entry points), and `next.config.ts` at the project root if
 * present. Deliberately NOT "every file under src/" — that would defeat the purpose of a REACHABILITY
 * check by making every file trivially its own root.
 */
export function findProductionRoots(rootSrcDir, rootProjectDir) {
  const roots = [];
  const appDir = path.join(rootSrcDir, "app");
  if (existsSync(appDir)) {
    (function walk(dir) {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry) && !isTestFile(entry)) roots.push(full);
      }
    })(appDir);
  }
  const configDir = path.join(rootSrcDir, "config");
  if (existsSync(configDir)) {
    for (const entry of readdirSync(configDir)) {
      const full = path.join(configDir, entry);
      if (statSync(full).isFile() && /\.tsx?$/.test(entry) && !isTestFile(entry)) roots.push(full);
    }
  }
  if (rootProjectDir) {
    const nextConfig = path.join(rootProjectDir, "next.config.ts");
    if (existsSync(nextConfig)) roots.push(nextConfig);
  }
  return roots;
}

/**
 * Traverses the real production dependency graph from `roots`, following every import/re-export/
 * export-all/dynamic-import/require edge (resolved against `compilerOptions`, so tsconfig path aliases
 * are honored exactly like the real compiler), and reports every root that can reach a PROHIBITED
 * TARGET, every unresolved local import along the way, and — for every visited file — any CONTENT RULE
 * violation. Returns `{ violations, unresolvedImports, scannedCount }`.
 *
 * REM-002: `isProhibitedTarget`/`prohibitedCategory`/`contentRules` are pluggable (default to this
 * file's own sandbox-specific definitions below) precisely so `check-no-adyen-dependency.mjs` can reuse
 * this ENTIRE traversal engine — module resolution, path-alias handling, root discovery, chain
 * tracking — for an independent, differently-defined prohibition, rather than re-implementing dependency
 * graph traversal a second time.
 *
 * @param {object} args
 * @param {string[]} args.roots
 * @param {object} args.compilerOptions
 * @param {string} args.rootSrcDir
 * @param {(file: string, text: string) => boolean} [args.isProhibitedTarget]
 * @param {string} [args.prohibitedCategory]
 * @param {(file: string, text: string) => string} [args.prohibitedDetail]
 * @param {Array<{ category: string, test: (text: string, file: string) => boolean, detail: (text: string) => string }>} [args.contentRules]
 */
export function runGraphCheck({
  roots,
  compilerOptions,
  rootSrcDir,
  isProhibitedTarget = isProhibitedSandboxTarget,
  prohibitedCategory = "sandbox-provider-reachable-from-production",
  prohibitedDetail = (file) => `Production entry point can reach sandbox provider implementation: ${path.relative(rootSrcDir, file)}`,
  contentRules = DEFAULT_SANDBOX_CONTENT_RULES,
}) {
  const visited = new Map(); // resolved file path -> true
  const violations = [];
  const unresolvedImports = [];
  const queue = roots.map((r) => ({ file: path.resolve(r), chain: [path.resolve(r)], root: path.resolve(r) }));
  let scannedCount = 0;

  while (queue.length > 0) {
    const { file, chain, root } = queue.shift();
    if (visited.has(file)) continue;
    visited.set(file, true);
    if (!existsSync(file)) continue;
    scannedCount += 1;
    const text = readFileSync(file, "utf8");

    if (isProhibitedTarget(file, text)) {
      violations.push({
        category: prohibitedCategory,
        root,
        chain,
        target: file,
        detail: prohibitedDetail(file, text),
      });
      continue; // do not traverse further from inside the prohibited file itself.
    }

    // Content-only checks, over every production-reachable file (never over unreached excluded-dir content).
    for (const rule of contentRules) {
      if (rule.test(text, file)) {
        violations.push({ category: rule.category, root, chain, target: file, detail: rule.detail(text) });
      }
    }

    let refs;
    try {
      refs = extractModuleReferences(file, text);
    } catch {
      continue; // a file that fails to even parse is not this script's concern (typecheck/build would catch it).
    }
    for (const ref of refs) {
      if (ref.specifier == null) continue; // non-literal dynamic import()/require() — cannot be resolved statically.
      const resolved = resolveSpecifier(ref.specifier, file, compilerOptions);
      if (resolved.kind === "external") continue;
      if (resolved.kind === "unresolved") {
        unresolvedImports.push({ root, chain, specifier: ref.specifier, importingFile: file });
        violations.push({
          category: "unresolved-local-import",
          root,
          chain,
          target: ref.specifier,
          detail: `${path.relative(rootSrcDir, file)} imports "${ref.specifier}" (kind: ${ref.kind}) — could not be resolved to a real file. An unresolved local import is never treated as safe.`,
        });
        continue;
      }
      queue.push({ file: resolved.file, chain: [...chain, resolved.file], root });
    }
  }

  return { violations, unresolvedImports, scannedCount };
}

function main() {
  const compilerOptions = loadCompilerOptions(projectRoot);
  const roots = findProductionRoots(srcDir, projectRoot);
  const { violations, scannedCount } = runGraphCheck({ roots, compilerOptions, rootSrcDir: srcDir });

  if (violations.length > 0) {
    for (const v of violations) {
      const chainDisplay = v.chain.map((f) => path.relative(projectRoot, f)).join("\n      -> ");
      console.error(
        `[no-sandbox-runtime] VIOLATION (${v.category})\n` +
          `  Production entry point: ${path.relative(projectRoot, v.root)}\n` +
          `  Dependency chain:\n      -> ${chainDisplay}\n` +
          `  Prohibited target: ${typeof v.target === "string" && existsSync(v.target) ? path.relative(projectRoot, v.target) : v.target}\n` +
          `  Detail: ${v.detail}`,
      );
    }
    console.error(
      "\n[no-sandbox-runtime] FAILED — sandbox/mock financial provider functionality is reachable from real " +
        "production entry points (see docs/PRODUCTION_PROVIDER_READINESS.md and the B0-D TOTAL SANDBOX ELIMINATION " +
        "remediation). Sandbox provider implementations may exist ONLY under src/test-support/, and no production " +
        "entry point (src/app/**, src/config/**, next.config.ts) may transitively import them through any number " +
        "of intermediary modules, re-exports, or aliases.",
    );
    process.exitCode = 1;
  } else {
    console.log(
      `[no-sandbox-runtime] OK — traversed ${scannedCount} module(s) reachable from ${roots.length} production entry point(s); no sandbox provider is reachable from production, no unresolved local import, no other violation.`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
