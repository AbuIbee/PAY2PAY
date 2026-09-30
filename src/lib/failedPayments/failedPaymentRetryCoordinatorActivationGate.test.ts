import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import type { Database } from "@/db/client";
import type { PaymentProvider } from "@/lib/payments/paymentProvider";
import { DrizzleFailedPaymentRetryCoordinator } from "./failedPaymentRetryCoordinator";
import type { ProviderOutcomeEffectApplier } from "./paymentRetryService";

/**
 * REM-008 — payment activation gate, tested directly against `DrizzleFailedPaymentRetryCoordinator`'s
 * own PRIVATE dispatch methods (`dispatchProviderCallForAnchor`, `resolveNotFoundOutcome`) — never the
 * standalone `DrizzlePaymentInitiationEligibilityService` alone, and never routed through
 * `PaymentRetryService`/a production factory (which would only prove the CALLER checks eligibility
 * first, not that this class fails closed on its own terms).
 *
 * Scope note: this class's authorized (`true`) path is deliberately, exclusively tested elsewhere —
 * against the real production factory (`getFailedPaymentRetryCoordinator.ts`) and this repository's
 * `installmentAmountAwareness.postgres.test.ts` / `paymentWebhookRecovery.postgres.test.ts` — run only
 * against a REAL Postgres database, since this class performs real row-locking (`for("update")`), multi-table
 * transactional writes, and concurrency-dependent behavior that an in-memory fake cannot faithfully
 * reproduce without either being so complex it becomes untrustworthy, or silently misrepresenting real
 * transactional semantics. This file exercises ONLY the scenarios that are honestly testable without a
 * real database: both dispatch sites' activation gate, in the BLOCKED (false/undefined) configuration,
 * where the guard is checked (see failedPaymentRetryCoordinator.ts) BEFORE `this.db.transaction(...)`
 * is ever opened — so a `db` stub whose `transaction` method throws if invoked proves, by construction,
 * that the real transactional path (installment locking, anchor mutation, provider dispatch) was never
 * reached. The AUTHORIZED (`true`) configuration, and any assertion requiring inspection of actually
 * persisted database state (TEST 008-C/F/G/H/I in the governing control order), requires a real
 * database and is BLOCKED in this environment — see this repo's own postgres test suites
 * (`installmentAmountAwareness.postgres.test.ts`, `paymentWebhookRecovery.postgres.test.ts`) for the
 * equivalent AUTHORIZED-path coverage, run only against an independently verified isolated database.
 */

function throwingDb(): Database {
  return {
    transaction: () => {
      throw new Error("dispatchProviderCallForAnchor/resolveNotFoundOutcome must never open a transaction while the activation gate is blocked");
    },
  } as unknown as Database;
}

function countingProvider() {
  const createPayment = vi.fn(async () => {
    throw new Error("provider.createPayment must never be called while the activation gate is blocked");
  });
  const provider = {
    providerName: "test_counting_provider",
    providerEnvironment: "sandbox",
    createPayment,
  } as unknown as PaymentProvider;
  return { provider, createPayment };
}

const noopEffectApplier: ProviderOutcomeEffectApplier = {
  receiveInternalEvent: async () => ({ status: "processed" }),
};

/**
 * SV-006: the production constructor's 7th argument is now a genuine, non-optional `boolean` — a real
 * TypeScript caller can no longer express `undefined` here (see CT-002 below). This helper's own
 * parameter type is deliberately the same strict `boolean`, so it can only ever be used for the
 * `false`/`true` cases; TEST 008-B/E's `undefined` case is constructed directly, with its own
 * documented, localized unsafe boundary (see those tests).
 */
function buildCoordinator(newPaymentInitiationVerified: boolean) {
  return new DrizzleFailedPaymentRetryCoordinator(throwingDb(), undefined, undefined, undefined, undefined, undefined, newPaymentInitiationVerified);
}

describe("DrizzleFailedPaymentRetryCoordinator — payment activation gate (REM-008 / SV-006 / SV-007)", () => {
  describe("primary dispatch (dispatchProviderCallForAnchor, reached via the public claimAndExecuteRetry)", () => {
    it("TEST 008-A: flag false — zero provider.createPayment calls, zero database transaction, outcome 'ambiguous' (never 'failed', never consumes the claim)", async () => {
      const coordinator = buildCoordinator(false);
      const { provider, createPayment } = countingProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (coordinator as any).dispatchProviderCallForAnchor({
        installmentScheduleItemId: "installment-1",
        retryId: "retry-1",
        paymentAttemptId: "payment-attempt-1",
        agreementId: "agreement-1",
        provider,
        effectApplier: noopEffectApplier,
      });
      expect(createPayment).not.toHaveBeenCalled();
      expect(result).toEqual({ outcome: "ambiguous", paymentAttemptId: "payment-attempt-1" });
    });

    it("TEST 008-B: flag undefined — identical to false: zero provider.createPayment calls, zero database transaction. SV-006 localized unsafe boundary: the constructor's own type now requires a genuine `boolean` for this argument (CT-002), so a real TypeScript caller cannot express `undefined` here anymore — this cast simulates an invalid JavaScript caller (plain JS, a stale .d.ts, a dynamically-built argument list) bypassing that compile-time protection, to prove the RUNTIME guard still independently fails closed even when TypeScript's own protection is circumvented. This is defense-in-depth verification, never a substitute for SV-006 itself.", async () => {
      const coordinator = new DrizzleFailedPaymentRetryCoordinator(
        throwingDb(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        undefined as any,
      );
      const { provider, createPayment } = countingProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (coordinator as any).dispatchProviderCallForAnchor({
        installmentScheduleItemId: "installment-1",
        retryId: "retry-1",
        paymentAttemptId: "payment-attempt-1",
        agreementId: "agreement-1",
        provider,
        effectApplier: noopEffectApplier,
      });
      expect(createPayment).not.toHaveBeenCalled();
      expect(result).toEqual({ outcome: "ambiguous", paymentAttemptId: "payment-attempt-1" });
    });

    it("direct invocation of the private dispatch method (bypassing claimAndExecuteRetry/PaymentRetryService.fireDueRetries entirely) is STILL blocked — proves this class is fail-closed on its own terms, never merely by caller convention", async () => {
      // Same assertion as 008-A, phrased to make explicit what it proves: nothing about
      // PaymentRetryService or DrizzlePaymentInitiationEligibilityService is involved in this test at
      // all — only the coordinator's own constructor argument and its own dispatch method.
      const coordinator = buildCoordinator(false);
      const { provider, createPayment } = countingProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (coordinator as any).dispatchProviderCallForAnchor({
        installmentScheduleItemId: "installment-1",
        retryId: "retry-1",
        paymentAttemptId: "payment-attempt-1",
        agreementId: "agreement-1",
        provider,
        effectApplier: noopEffectApplier,
      });
      expect(createPayment).not.toHaveBeenCalled();
    });
  });

  describe("secondary redispatch (resolveNotFoundOutcome, reached via resolveAmbiguousRetry's resumption loop)", () => {
    it("TEST 008-D: flag false — zero provider.createPayment calls, zero database transaction, outcome 'still_ambiguous' (the original obligation is preserved for later authorized recovery)", async () => {
      const coordinator = buildCoordinator(false);
      const { provider, createPayment } = countingProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existing: any = { id: "payment-attempt-1", idempotencyKey: "idem-1" };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (coordinator as any).resolveNotFoundOutcome(existing, "installment-1", "retry-1", provider, noopEffectApplier);
      expect(createPayment).not.toHaveBeenCalled();
      expect(result).toEqual({ outcome: "still_ambiguous" });
    });

    it("TEST 008-E: flag undefined — identical to false: zero provider.createPayment calls, zero database transaction. Same SV-006 localized unsafe boundary as TEST 008-B — see that test's own doc comment.", async () => {
      const coordinator = new DrizzleFailedPaymentRetryCoordinator(
        throwingDb(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        undefined as any,
      );
      const { provider, createPayment } = countingProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existing: any = { id: "payment-attempt-1", idempotencyKey: "idem-1" };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (coordinator as any).resolveNotFoundOutcome(existing, "installment-1", "retry-1", provider, noopEffectApplier);
      expect(createPayment).not.toHaveBeenCalled();
      expect(result).toEqual({ outcome: "still_ambiguous" });
    });
  });

  /**
   * SV-006 — compile-time-only contract checks (CT-001 through CT-004). This function is declared but
   * INTENTIONALLY NEVER CALLED anywhere in this file or any other — `tsc --noEmit` (the repository's
   * own normal typecheck, which includes every `.ts` file per tsconfig.json's `"**\/*.ts"` include
   * pattern) still type-checks its body, which is the entire point: these are compile-time assertions
   * enforced by `npm run typecheck`, not executed runtime test code. Nothing inside this function ever
   * runs at test time — no real service, provider, or database is touched, satisfying "do not
   * instantiate real financial services as a side effect of type-contract testing." If a future edit
   * makes the constructor permissive again (reintroducing a default, a `?`, or a `boolean | undefined`
   * union on the 7th parameter), the `@ts-expect-error` directives below become UNUSED — TypeScript
   * itself reports "Unused '@ts-expect-error' directive" as a compile ERROR — and `npm run typecheck`
   * fails, exactly the regression-detection CT-001/CT-002 require.
   */
  function _sv006CompileTimeOnlyContractChecks(): void {
    const db = throwingDb();

    // CT-001: a constructor invocation with SIX arguments (omitting the required 7th) must fail to
    // compile — the 7th argument is no longer optional.
    // @ts-expect-error CT-001 — newPaymentInitiationVerified (the 7th argument) is required; omitting it must not compile.
    new DrizzleFailedPaymentRetryCoordinator(db, undefined, undefined, undefined, undefined, undefined);

    // CT-002: a constructor invocation with SEVEN arguments where argument seven is `undefined` must
    // fail to compile — the parameter's type is a bare `boolean`, never a union with `undefined`.
    // @ts-expect-error CT-002 — `undefined` is not assignable to the required `boolean` 7th argument.
    new DrizzleFailedPaymentRetryCoordinator(db, undefined, undefined, undefined, undefined, undefined, undefined);

    // CT-003: a constructor invocation with SEVEN arguments where argument seven is `false` must be
    // ACCEPTED — no `@ts-expect-error` here; if this line itself produced a real compile error, the
    // repository's own `npm run typecheck` would fail on this line, which is the negative proof that
    // this specific construction is genuinely valid.
    new DrizzleFailedPaymentRetryCoordinator(db, undefined, undefined, undefined, undefined, undefined, false);

    // CT-004: a constructor invocation with SEVEN arguments where argument seven is `true` must be
    // ACCEPTED.
    new DrizzleFailedPaymentRetryCoordinator(db, undefined, undefined, undefined, undefined, undefined, true);
  }
  // Referenced (never invoked) purely so `tsc --noEmit`'s `noUnusedLocals` doesn't flag the function
  // itself as dead code — this does NOT call it; the function body above still never executes.
  void _sv006CompileTimeOnlyContractChecks;

  describe("SV-007 — structural AST verification of the production factory's 7th constructor argument", () => {
    /**
     * CONTROL ORDER 004-B correction: the previous version of this helper matched ANY
     * `new DrizzleFailedPaymentRetryCoordinator(...)` expression anywhere in the file whose immediate
     * parent was an assignment to an identifier merely spelled `cached` — regardless of which function
     * that assignment lived in, and WITHOUT unwrapping a `ParenthesizedExpression` wrapper first. Codex
     * demonstrated this false-passes: a `(new DrizzleFailedPaymentRetryCoordinator(...))` (parenthesized)
     * production call is invisible to a raw `node.parent` check (the parent of a `NewExpression` inside
     * parens is the `ParenthesizedExpression`, never the `BinaryExpression`) — so if the ACTUAL,
     * misconfigured production assignment is parenthesized, the old helper silently skipped it and could
     * instead pick up an unrelated, correctly-configured `cached = new DrizzleFailedPaymentRetryCoordinator(...)`
     * sitting in a completely different function, reporting PASS while the real production wiring was
     * broken (see R3 below — the exact Codex reproduction).
     *
     * This version fixes both root causes by construction, not by pattern-matching harder:
     *   1. It first locates the actual exported `function getFailedPaymentRetryCoordinator` declaration
     *      by NAME — never "any function", never "the whole file" — establishing which function IS the
     *      production factory before looking at any constructor expression at all.
     *   2. It reads that function's own `return <identifier>;` statement to identify the exact cache
     *      binding it exposes (its "return flow") — the singleton variable the factory actually hands
     *      back to callers.
     *   3. It then searches ONLY the factory's own top-level statements (never descending into any
     *      nested function/arrow/method boundary inside it — requirement 9's nested-decoy protection)
     *      for an assignment to that SAME identifier, unwrapping any `ParenthesizedExpression` wrapper
     *      on the right-hand side first (requirement 5) before checking whether it is the
     *      `DrizzleFailedPaymentRetryCoordinator` constructor.
     * An assignment inside any OTHER function — regardless of what it assigns to, or what it's named —
     * is structurally invisible to this search: ownership is established by which function's body the
     * assignment textually lives in, not by variable-name coincidence alone. Throws (fails closed) if
     * zero or more than one qualifying assignment is found inside the factory itself.
     *
     * CONTROL ORDER STAGE-01-FINAL corrections (004-BV-001 / 004-BV-002), on top of the above:
     *
     * 004-BV-002 (exported-function identity): the previous version accepted the LAST top-level
     * `function getFailedPaymentRetryCoordinator` it found, regardless of whether it was actually
     * exported, and silently ignored the possibility of more than one such declaration. This version
     * requires an actual `export` modifier, and fails closed (ambiguous) rather than silently picking
     * one if more than one exported declaration with that name exists at the top level.
     *
     * 004-BV-001 (cache-binding shadowing): the previous version matched a candidate assignment purely
     * by comparing identifier TEXT against the factory's returned name — `node.left.text === returnedName`
     * — which cannot distinguish the real, outer, module-level `cached` from an inner `let`/`const`/
     * catch-binding that happens to share the same spelling and shadows it within a nested block. Codex
     * demonstrated a source where an inner block declares its own `let cached`, assigns a correctly
     * configured coordinator to THAT shadowed binding, while the factory actually `return`s the outer,
     * untouched module-level `cached` — the previous helper accepted this as if the outer cache had been
     * populated. This version scans the exact same reachable region the assignment search itself visits
     * (every statement the factory's own body reaches, WITHOUT descending into any nested function/
     * arrow/method body — identical scoping to the assignment search itself, so a nested function's own
     * unrelated local variable of the same name — which nothing inside it is ever harvested from anyway,
     * per the nested-decoy protection above — can never trigger a false rejection) for any declaration
     * of the returned name via `let`/`const`/`var`, a catch-clause binding, or a destructuring pattern
     * binding that name, plus the factory's own parameter list. If any such shadowing declaration is
     * found, this fails closed (rejects) rather than attempt to disambiguate cleverly — matching the
     * order's own "the acceptable implementation is to reject any factory source containing an ambiguous
     * shadow declaration that prevents trustworthy assignment identification" instruction. This is a
     * narrow, purpose-built structural check, not a general-purpose data-flow/symbol-resolution
     * framework — JavaScript/TypeScript lexical scoping guarantees that a name not locally (re)declared
     * anywhere the search actually visits still refers to the same outer binding everywhere in that
     * visited region, which is all this helper needs to trust its own match.
     */
    function findProductionFactoryCoordinatorCall(sourceText: string, fileName = "factory.ts"): ts.NewExpression {
      const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

      function isExportedFunctionDeclaration(node: ts.Node): node is ts.FunctionDeclaration {
        return (
          ts.isFunctionDeclaration(node) &&
          !!node.body &&
          node.name?.text === "getFailedPaymentRetryCoordinator" &&
          ts.canHaveModifiers(node) &&
          (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)
        );
      }

      const exportedCandidates: ts.FunctionDeclaration[] = [];
      ts.forEachChild(sourceFile, (node) => {
        if (isExportedFunctionDeclaration(node)) {
          exportedCandidates.push(node);
        }
      });
      if (exportedCandidates.length === 0) {
        throw new Error(
          "No EXPORTED `function getFailedPaymentRetryCoordinator(...) { ... }` declaration found at the top level of the given source — an unexported same-named function, a nested function, a function expression, or a similarly-named identifier does not count.",
        );
      }
      if (exportedCandidates.length > 1) {
        throw new Error(
          `Ambiguous: found ${exportedCandidates.length} top-level exported \`function getFailedPaymentRetryCoordinator\` declarations — expected exactly one.`,
        );
      }
      const [factoryFn] = exportedCandidates;
      if (!factoryFn?.body) {
        throw new Error("Unreachable: exportedCandidates.length === 1 was just checked.");
      }
      const factoryBody = factoryFn.body;

      let returnedName: string | undefined;
      for (const statement of factoryBody.statements) {
        if (ts.isReturnStatement(statement) && statement.expression && ts.isIdentifier(statement.expression)) {
          returnedName = statement.expression.text;
        }
      }
      if (!returnedName) {
        throw new Error(
          "Could not identify the production factory's cache-binding return flow — expected a top-level `return <identifier>;` statement.",
        );
      }

      function declaresName(bindingName: ts.BindingName, name: string): boolean {
        if (ts.isIdentifier(bindingName)) return bindingName.text === name;
        if (ts.isObjectBindingPattern(bindingName) || ts.isArrayBindingPattern(bindingName)) {
          for (const element of bindingName.elements) {
            if (!ts.isOmittedExpression(element) && declaresName(element.name, name)) return true;
          }
        }
        return false;
      }

      if (factoryFn.parameters.some((p) => declaresName(p.name, returnedName!))) {
        throw new Error(
          `Ambiguous: the production factory's own parameter list declares \`${returnedName}\`, which would shadow the module-level cache binding of the same name.`,
        );
      }

      function unwrapParens(expr: ts.Expression): ts.Expression {
        let current = expr;
        while (ts.isParenthesizedExpression(current)) {
          current = current.expression;
        }
        return current;
      }

      function isFunctionLike(node: ts.Node): boolean {
        return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
      }

      let shadowed = false;
      const candidates: ts.NewExpression[] = [];
      function visitWithinFactory(node: ts.Node): void {
        // Never descend into a nested function's own body — a correctly-configured constructor call
        // (or a locally-scoped shadow declaration) inside a nested decoy function must never be mistaken
        // for the factory's own cache assignment (requirement 9 / SV7-08), and can never falsely trigger
        // shadow-rejection either, since nothing inside it is ever harvested regardless.
        if (isFunctionLike(node)) {
          return;
        }
        if (ts.isVariableDeclaration(node) && declaresName(node.name, returnedName!)) {
          shadowed = true;
        }
        if (ts.isCatchClause(node) && node.variableDeclaration && declaresName(node.variableDeclaration.name, returnedName!)) {
          shadowed = true;
        }
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(node.left) &&
          node.left.text === returnedName
        ) {
          const rhs = unwrapParens(node.right);
          if (ts.isNewExpression(rhs) && ts.isIdentifier(rhs.expression) && rhs.expression.text === "DrizzleFailedPaymentRetryCoordinator") {
            candidates.push(rhs);
          }
        }
        ts.forEachChild(node, visitWithinFactory);
      }
      visitWithinFactory(factoryBody);

      if (shadowed) {
        throw new Error(
          `Ambiguous: a local declaration of \`${returnedName}\` (let/const/var/catch-binding/destructuring) exists inside the production factory's own reachable scope, which could shadow the module-level cache binding — refusing to trust an assignment identified under an unreliable binding identity.`,
        );
      }

      if (candidates.length === 0) {
        throw new Error(
          `No \`${returnedName} = new DrizzleFailedPaymentRetryCoordinator(...)\` assignment found inside the actual production factory (\`getFailedPaymentRetryCoordinator\`'s own body) — an assignment elsewhere in the file does not count.`,
        );
      }
      if (candidates.length > 1) {
        throw new Error(
          `Ambiguous: found ${candidates.length} candidate constructor assignments to \`${returnedName}\` inside the actual production factory's own body — expected exactly one.`,
        );
      }
      const [candidate] = candidates;
      if (!candidate) {
        throw new Error("Unreachable: candidates.length === 1 was just checked.");
      }
      return candidate;
    }

    /**
     * Structurally verifies the 7th argument of a `NewExpression` is EXACTLY
     * `getServerEnv().PAYMENT_INITIATION_VERIFIED` — a real AST shape check (requirements B-G): a
     * `PropertyAccessExpression` named `PAYMENT_INITIATION_VERIFIED` (G) over a zero-argument
     * `CallExpression` invoking an identifier named `getServerEnv` (D), never a `BooleanLiteral true`
     * (F) — never a source-text `.includes()`/regex check that a mere COMMENT mentioning the same
     * string could satisfy while the real argument is a hardcoded `true`.
     */
    function assertSeventhArgumentIsPaymentInitiationVerified(newExpr: ts.NewExpression): void {
      const args = newExpr.arguments ?? [];
      if (args.length !== 7) {
        throw new Error(`Expected exactly 7 constructor arguments (requirement B), found ${args.length}.`);
      }
      const seventh = args[6];
      if (!seventh) {
        throw new Error("Unreachable: args.length === 7 was just checked.");
      }

      if (seventh.kind === ts.SyntaxKind.TrueKeyword) {
        throw new Error("The 7th argument is a hardcoded literal `true` (violates requirement F) — never the real operator-configured value.");
      }
      if (!ts.isPropertyAccessExpression(seventh)) {
        throw new Error(`The 7th argument is not a PropertyAccessExpression (requirement C) — got AST kind ${ts.SyntaxKind[seventh.kind]}.`);
      }
      if (seventh.name.text !== "PAYMENT_INITIATION_VERIFIED") {
        throw new Error(`The 7th argument accesses property "${seventh.name.text}", not "PAYMENT_INITIATION_VERIFIED" (violates requirement G).`);
      }
      const objectExpr = seventh.expression;
      if (!ts.isCallExpression(objectExpr) || !ts.isIdentifier(objectExpr.expression) || objectExpr.expression.text !== "getServerEnv") {
        throw new Error("The 7th argument's object is not a call to getServerEnv() (requirement D).");
      }
      if (objectExpr.arguments.length !== 0) {
        throw new Error("getServerEnv() must be invoked with zero arguments (requirement D).");
      }
    }

    /** Requirement E — the combined structural-equivalence assertion this whole helper exists to prove. */
    function assertFactoryWiresPaymentInitiationVerified(sourceText: string, fileName?: string): void {
      const newExpr = findProductionFactoryCoordinatorCall(sourceText, fileName);
      assertSeventhArgumentIsPaymentInitiationVerified(newExpr);
    }

    function readRealFactorySource(): string {
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      return readFileSync(path.join(__dirname, "getFailedPaymentRetryCoordinator.ts"), "utf8");
    }

    /** Locates the (unwrapped) production `NewExpression` node anywhere in `sourceText` — used only to
     * build mutated fixtures from the REAL file below, never as the identification mechanism itself
     * (that remains `findProductionFactoryCoordinatorCall`, exercised separately by every test here). */
    function locateAnyCoordinatorNewExpression(sourceText: string): ts.NewExpression {
      const sourceFile = ts.createSourceFile("real.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      let found: ts.NewExpression | undefined;
      function visit(node: ts.Node) {
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "DrizzleFailedPaymentRetryCoordinator") {
          found = node;
        }
        ts.forEachChild(node, visit);
      }
      visit(sourceFile);
      if (!found) {
        throw new Error("Fixture setup failure: could not locate the real production NewExpression to mutate.");
      }
      return found;
    }

    /** Splices raw character-offset edits into `sourceText` in a single pass, furthest offset first, so
     * earlier edits' offsets are never invalidated by later ones applied in the same call. */
    function spliceAt(sourceText: string, edits: { start: number; end: number; replacement: string }[]): string {
      let result = sourceText;
      for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
        result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
      }
      return result;
    }

    /** R2/R3/R9 fixture primitive: replaces the REAL production factory's actual 7th constructor
     * argument text with `replacement`, via AST-located character offsets (never a string search for
     * the argument's own text, which the argument's own value would defeat). */
    function withSeventhArgumentReplaced(sourceText: string, replacement: string): string {
      const newExpr = locateAnyCoordinatorNewExpression(sourceText);
      const args = newExpr.arguments ?? [];
      const seventh = args[6];
      if (args.length !== 7 || !seventh) {
        throw new Error("Fixture setup failure: the real production constructor no longer has exactly 7 arguments.");
      }
      return spliceAt(sourceText, [{ start: seventh.getStart(), end: seventh.getEnd(), replacement }]);
    }

    /** R3/R4 fixture primitive: wraps the REAL production factory's actual constructor expression in
     * parentheses — the exact shape Codex demonstrated the previous helper silently skipped. */
    function withProductionConstructorWrappedInParens(sourceText: string): string {
      const newExpr = locateAnyCoordinatorNewExpression(sourceText);
      return spliceAt(sourceText, [
        { start: newExpr.getEnd(), end: newExpr.getEnd(), replacement: ")" },
        { start: newExpr.getStart(), end: newExpr.getStart(), replacement: "(" },
      ]);
    }

    /** R9 fixture primitive: inserts a nested decoy function, containing its own correctly-configured
     * `cached = new DrizzleFailedPaymentRetryCoordinator(...)`, directly inside the real factory's own
     * body — proving a nested decoy can never rescue an incorrect OUTER (factory-level) assignment. */
    function withNestedDecoyFunctionInserted(sourceText: string): string {
      const sourceFile = ts.createSourceFile("real.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      let factoryFn: ts.FunctionDeclaration | undefined;
      ts.forEachChild(sourceFile, (node) => {
        if (ts.isFunctionDeclaration(node) && node.body && node.name?.text === "getFailedPaymentRetryCoordinator") {
          factoryFn = node;
        }
      });
      if (!factoryFn?.body) {
        throw new Error("Fixture setup failure: could not locate the factory body to insert a nested decoy into.");
      }
      const insertAt = factoryFn.body.getStart() + 1; // immediately after the body's opening `{`
      const decoy = `
    function nestedDecoyFactory() {
      let cached: unknown = null;
      if (!cached) {
        cached = new DrizzleFailedPaymentRetryCoordinator(
          undefined, DEFAULT_RETRY_DELAY_BUSINESS_DAYS, new AuditService(new DrizzleAuditEventRepository()), undefined, getPlatformFeePolicy(), getPartialPaymentAutoApplicationService(),
          getServerEnv().PAYMENT_INITIATION_VERIFIED
        );
      }
      return cached;
    }
`;
      return sourceText.slice(0, insertAt) + decoy + sourceText.slice(insertAt);
    }

    it("TEST 008-J / R1 / SV7-01 / SV7-05 — the REAL getFailedPaymentRetryCoordinator.ts, unmodified: PASS — its 7th constructor argument is structurally getServerEnv().PAYMENT_INITIATION_VERIFIED", () => {
      const source = readRealFactorySource();
      expect(() => assertFactoryWiresPaymentInitiationVerified(source, "getFailedPaymentRetryCoordinator.ts")).not.toThrow();
    });

    it("R2 / SV7-14 — the REAL factory source with its actual 7th argument replaced by `true`: FAIL", () => {
      const source = withSeventhArgumentReplaced(readRealFactorySource(), "true");
      expect(() => assertFactoryWiresPaymentInitiationVerified(source, "getFailedPaymentRetryCoordinator.ts")).toThrow(/hardcoded literal `true`/);
    });

    it("SV7-02 — EXACT CODEX SHADOWING REPRODUCTION (004-BV-001): an inner block declares its OWN `let cached`, assigns a correctly-configured coordinator to THAT shadowed binding, while the factory actually returns the untouched OUTER module-level `cached`: FAIL — a shadowed inner assignment must never be mistaken for the module cache actually being populated", () => {
      const source = `
let cached = null;

export function getFailedPaymentRetryCoordinator() {
  {
    let cached = null;

    if (!cached) {
      cached = new DrizzleFailedPaymentRetryCoordinator(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        getServerEnv().PAYMENT_INITIATION_VERIFIED,
      );
    }
  }

  return cached;
}
`;
      expect(() => assertFactoryWiresPaymentInitiationVerified(source)).toThrow(/shadow/i);
    });

    it("SV7-03 — a correctly-configured but UNEXPORTED function bearing the factory's exact name: FAIL — an unexported declaration is never accepted as the production factory", () => {
      const source = `
import { getServerEnv } from "@/config/env";
let cached = null;
function getFailedPaymentRetryCoordinator() {
  if (!cached) {
    cached = new DrizzleFailedPaymentRetryCoordinator(
      undefined, DEFAULT_RETRY_DELAY_BUSINESS_DAYS, new AuditService(new DrizzleAuditEventRepository()), undefined, getPlatformFeePolicy(), getPartialPaymentAutoApplicationService(),
      getServerEnv().PAYMENT_INITIATION_VERIFIED
    );
  }
  return cached;
}
`;
      expect(() => assertFactoryWiresPaymentInitiationVerified(source)).toThrow(/No EXPORTED/);
    });

    it("SV7-04 — two AMBIGUOUS top-level exported declarations sharing the factory's exact name: FAIL — the helper never silently picks the last one", () => {
      const source = `
import { getServerEnv } from "@/config/env";
let cached = null;
export function getFailedPaymentRetryCoordinator() {
  if (!cached) {
    cached = new DrizzleFailedPaymentRetryCoordinator(
      undefined, DEFAULT_RETRY_DELAY_BUSINESS_DAYS, new AuditService(new DrizzleAuditEventRepository()), undefined, getPlatformFeePolicy(), getPartialPaymentAutoApplicationService(),
      getServerEnv().PAYMENT_INITIATION_VERIFIED
    );
  }
  return cached;
}
export function getFailedPaymentRetryCoordinator() {
  return cached;
}
`;
      expect(() => assertFactoryWiresPaymentInitiationVerified(source)).toThrow(/Ambiguous: found 2 top-level exported/);
    });

    it("SV7-20 — an unexported same-named function PLUS an unrelated exported function with a different name: FAIL — no valid exported production factory exists at all", () => {
      const source = `
import { getServerEnv } from "@/config/env";
let cached = null;
function getFailedPaymentRetryCoordinator() {
  if (!cached) {
    cached = new DrizzleFailedPaymentRetryCoordinator(
      undefined, DEFAULT_RETRY_DELAY_BUSINESS_DAYS, new AuditService(new DrizzleAuditEventRepository()), undefined, getPlatformFeePolicy(), getPartialPaymentAutoApplicationService(),
      getServerEnv().PAYMENT_INITIATION_VERIFIED
    );
  }
  return cached;
}
export function someUnrelatedExportedFunction() {
  return null;
}
`;
      expect(() => assertFactoryWiresPaymentInitiationVerified(source)).toThrow(/No EXPORTED/);
    });

    it("SV7-09 — a NESTED function's own parameter shares the returned cache name and constructs a coordinator inside that nested function, never assigning the actual module cache: FAIL — nothing inside a nested function is ever harvested as the factory's own assignment", () => {
      const source = `
import { getServerEnv } from "@/config/env";
let cached = null;
export function getFailedPaymentRetryCoordinator() {
  function nestedWithShadowParam(cached) {
    cached = new DrizzleFailedPaymentRetryCoordinator(
      undefined, DEFAULT_RETRY_DELAY_BUSINESS_DAYS, new AuditService(new DrizzleAuditEventRepository()), undefined, getPlatformFeePolicy(), getPartialPaymentAutoApplicationService(),
      getServerEnv().PAYMENT_INITIATION_VERIFIED
    );
    return cached;
  }
  nestedWithShadowParam(null);
  return cached;
}
`;
      expect(() => assertFactoryWiresPaymentInitiationVerified(source)).toThrow(/No `cached = new DrizzleFailedPaymentRetryCoordinator/);
    });

    it("SV7-10 — a catch binding inside the factory's OWN body (not a nested function) shadows the returned cache name and receives the only coordinator construction: FAIL", () => {
      const source = `
import { getServerEnv } from "@/config/env";
let cached = null;
export function getFailedPaymentRetryCoordinator() {
  try {
    throw new Error("trigger");
  } catch (cached) {
    cached = new DrizzleFailedPaymentRetryCoordinator(
      undefined, DEFAULT_RETRY_DELAY_BUSINESS_DAYS, new AuditService(new DrizzleAuditEventRepository()), undefined, getPlatformFeePolicy(), getPartialPaymentAutoApplicationService(),
      getServerEnv().PAYMENT_INITIATION_VERIFIED
    );
  }
  return cached;
}
`;
      expect(() => assertFactoryWiresPaymentInitiationVerified(source)).toThrow(/shadow/i);
    });

    it("SV7-11 — a block-local `let` (minimal case, distinct from SV7-02's exact Codex reproduction) shadows the returned cache name and receives the only constructor assignment: FAIL", () => {
      const source = `
import { getServerEnv } from "@/config/env";
let cached = null;
export function getFailedPaymentRetryCoordinator() {
  {
    let cached = null;
    if (!cached) {
      cached = new DrizzleFailedPaymentRetryCoordinator(
        undefined, DEFAULT_RETRY_DELAY_BUSINESS_DAYS, new AuditService(new DrizzleAuditEventRepository()), undefined, getPlatformFeePolicy(), getPartialPaymentAutoApplicationService(),
        getServerEnv().PAYMENT_INITIATION_VERIFIED
      );
    }
  }
  return cached;
}
`;
      expect(() => assertFactoryWiresPaymentInitiationVerified(source)).toThrow(/shadow/i);
    });

    it("R3 / SV7-07 — EXACT CODEX FALSE-PASS REPRODUCTION: the REAL production constructor wrapped in parentheses, its 7th argument changed to `true`, PLUS an unrelated function with its own correctly-configured `cached = new DrizzleFailedPaymentRetryCoordinator(...)`: FAIL — the real (parenthesized, misconfigured) production assignment must still be the one identified, never the unrelated correctly-configured one", () => {
      let source = withSeventhArgumentReplaced(readRealFactorySource(), "true");
      source = withProductionConstructorWrappedInParens(source);
      source += `
export function unrelatedFactoryAlsoUsingCached() {
  let cached: unknown = null;
  if (!cached) {
    cached = new DrizzleFailedPaymentRetryCoordinator(
      undefined, DEFAULT_RETRY_DELAY_BUSINESS_DAYS, new AuditService(new DrizzleAuditEventRepository()), undefined, getPlatformFeePolicy(), getPartialPaymentAutoApplicationService(),
      getServerEnv().PAYMENT_INITIATION_VERIFIED
    );
  }
  return cached;
}
`;
      expect(() => assertFactoryWiresPaymentInitiationVerified(source, "getFailedPaymentRetryCoordinator.ts")).toThrow(/hardcoded literal `true`/);
    });

    it("R4 / SV7-06 — the REAL factory's correct construction wrapped in parentheses, otherwise unmodified: PASS", () => {
      const source = withProductionConstructorWrappedInParens(readRealFactorySource());
      expect(() => assertFactoryWiresPaymentInitiationVerified(source, "getFailedPaymentRetryCoordinator.ts")).not.toThrow();
    });

    it("SV7-19 — the REAL factory's correct construction wrapped in MULTIPLE nested parentheses: PASS — unwrapParens handles more than one layer, distinct from SV7-06's single-wrap case", () => {
      const onceWrapped = withProductionConstructorWrappedInParens(readRealFactorySource());
      const twiceWrapped = withProductionConstructorWrappedInParens(onceWrapped);
      expect(() => assertFactoryWiresPaymentInitiationVerified(twiceWrapped, "getFailedPaymentRetryCoordinator.ts")).not.toThrow();
    });

    it("R9 / SV7-08 — the REAL factory's actual (outer) construction misconfigured (`true`), PLUS a correctly-configured constructor inside a NESTED decoy function declared inside the factory's own body: FAIL — a nested decoy must never rescue the real, outer, incorrect assignment", () => {
      let source = withSeventhArgumentReplaced(readRealFactorySource(), "true");
      source = withNestedDecoyFunctionInserted(source);
      expect(() => assertFactoryWiresPaymentInitiationVerified(source, "getFailedPaymentRetryCoordinator.ts")).toThrow(/hardcoded literal `true`/);
    });

    function fixtureSource(seventhArg: string | null, extra: { leadingComment?: string; extraStatement?: string; argCount?: number } = {}): string {
      const baseArgs = [
        "undefined",
        "DEFAULT_RETRY_DELAY_BUSINESS_DAYS",
        "new AuditService(new DrizzleAuditEventRepository())",
        "undefined",
        "getPlatformFeePolicy()",
        "getPartialPaymentAutoApplicationService()",
      ];
      const args = extra.argCount === 6 ? baseArgs : [...baseArgs, seventhArg ?? "true"];
      return `
import { getServerEnv } from "@/config/env";
${extra.leadingComment ?? ""}
let cached = null;
export function getFailedPaymentRetryCoordinator() {
  if (!cached) {
    cached = new DrizzleFailedPaymentRetryCoordinator(
      ${args.join(",\n      ")}
    );
  }
  ${extra.extraStatement ?? ""}
  return cached;
}
`;
    }

    function unrelatedFunctionSource(name: string, seventhArg: string): string {
      return `
export function ${name}() {
  let unrelatedCached: unknown = null;
  if (!unrelatedCached) {
    unrelatedCached = new DrizzleFailedPaymentRetryCoordinator(
      undefined, DEFAULT_RETRY_DELAY_BUSINESS_DAYS, new AuditService(new DrizzleAuditEventRepository()), undefined, getPlatformFeePolicy(), getPartialPaymentAutoApplicationService(),
      ${seventhArg}
    );
  }
  return unrelatedCached;
}
`;
    }

    it("R5 — the factory constructs SOMETHING, but not into the identifier it actually returns (no `cached = new DrizzleFailedPaymentRetryCoordinator(...)` exists inside the factory itself): FAIL", () => {
      const source = `
import { getServerEnv } from "@/config/env";
let cached = null;
let decoyCached = null;
export function getFailedPaymentRetryCoordinator() {
  if (!decoyCached) {
    decoyCached = new DrizzleFailedPaymentRetryCoordinator(
      undefined, DEFAULT_RETRY_DELAY_BUSINESS_DAYS, new AuditService(new DrizzleAuditEventRepository()), undefined, getPlatformFeePolicy(), getPartialPaymentAutoApplicationService(),
      getServerEnv().PAYMENT_INITIATION_VERIFIED
    );
  }
  return cached;
}
`;
      expect(() => assertFactoryWiresPaymentInitiationVerified(source)).toThrow(/No `cached = new DrizzleFailedPaymentRetryCoordinator/);
    });

    it("R6 / SV7-13 — two genuinely ambiguous `cached = new DrizzleFailedPaymentRetryCoordinator(...)` assignments, BOTH directly inside the actual factory's own body (if/else): FAIL as ambiguous", () => {
      const source = `
import { getServerEnv } from "@/config/env";
let cached = null;
export function getFailedPaymentRetryCoordinator() {
  if (!cached) {
    cached = new DrizzleFailedPaymentRetryCoordinator(
      undefined, DEFAULT_RETRY_DELAY_BUSINESS_DAYS, new AuditService(new DrizzleAuditEventRepository()), undefined, getPlatformFeePolicy(), getPartialPaymentAutoApplicationService(),
      getServerEnv().PAYMENT_INITIATION_VERIFIED
    );
  } else {
    cached = new DrizzleFailedPaymentRetryCoordinator(
      undefined, DEFAULT_RETRY_DELAY_BUSINESS_DAYS, new AuditService(new DrizzleAuditEventRepository()), undefined, getPlatformFeePolicy(), getPartialPaymentAutoApplicationService(),
      getServerEnv().PAYMENT_INITIATION_VERIFIED
    );
  }
  return cached;
}
`;
      expect(() => assertFactoryWiresPaymentInitiationVerified(source)).toThrow(/Ambiguous/);
    });

    it("R7 / SV7-12 — correct production construction plus an unrelated, differently-named function with its OWN correct construction: PASS — the unrelated function is never consulted", () => {
      const source = fixtureSource("getServerEnv().PAYMENT_INITIATION_VERIFIED") + unrelatedFunctionSource("unrelatedFactory", "getServerEnv().PAYMENT_INITIATION_VERIFIED");
      expect(() => assertFactoryWiresPaymentInitiationVerified(source)).not.toThrow();
    });

    it("R8 — correct production construction plus an unrelated, differently-named function with an INCORRECT construction: PASS — the unrelated function's defect never leaks into the real result", () => {
      const source = fixtureSource("getServerEnv().PAYMENT_INITIATION_VERIFIED") + unrelatedFunctionSource("unrelatedFactory", "true");
      expect(() => assertFactoryWiresPaymentInitiationVerified(source)).not.toThrow();
    });

    it("R10 / SV7-15 — a factory fixture with argument seven set to getServerEnv().SOME_OTHER_FLAG: FAIL", () => {
      const source = fixtureSource("getServerEnv().SOME_OTHER_FLAG");
      expect(() => assertFactoryWiresPaymentInitiationVerified(source)).toThrow(/SOME_OTHER_FLAG/);
    });

    it("R11 / SV7-16 — a factory fixture with only six arguments: FAIL", () => {
      const source = fixtureSource(null, { argCount: 6 });
      expect(() => assertFactoryWiresPaymentInitiationVerified(source)).toThrow(/Expected exactly 7 constructor arguments/);
    });

    it("R12 / SV7-17 — a factory fixture with argument seven set to `true`, PLUS a comment containing the correct expression string: FAIL — a comment is never accepted as the real argument", () => {
      const source = fixtureSource("true", { leadingComment: "// getServerEnv().PAYMENT_INITIATION_VERIFIED" });
      expect(() => assertFactoryWiresPaymentInitiationVerified(source)).toThrow(/hardcoded literal `true`/);
    });

    it("R13 / SV7-18 — a factory fixture containing the correct environment expression elsewhere in the SAME file, but the real 7th argument is `true`: FAIL", () => {
      const source = fixtureSource("true", {
        extraStatement: "const _unused = getServerEnv().PAYMENT_INITIATION_VERIFIED; void _unused;",
      });
      expect(() => assertFactoryWiresPaymentInitiationVerified(source)).toThrow(/hardcoded literal `true`/);
    });

    /**
     * CONTROL ORDER 004-B, Section 6 reconciliation: the former "NC-006" fixture placed its second,
     * correctly-configured `cached = new DrizzleFailedPaymentRetryCoordinator(...)` inside a
     * DIFFERENTLY-NAMED function (`getFailedPaymentRetryCoordinatorAlt`), not inside the actual
     * production factory — so it was never a valid test of ambiguity WITHIN the real factory (it
     * asserted `/Ambiguous/`, which the old file-wide, ownership-blind selector produced only because
     * it searched the whole file for anything named `cached`, not because two assignments actually
     * competed inside the same factory). Corrected expected behavior, per function ownership: since
     * `findProductionFactoryCoordinatorCall` now scopes its search to the named factory's own body only,
     * the alt function's assignment is structurally invisible, and this fixture's real production
     * assignment is unambiguous on its own — PASS. Genuine same-factory ambiguity is covered separately,
     * and correctly, by R6 above.
     */
    it("R6-reconciliation (formerly NC-006) — a correct production factory plus a second, differently-named function that reuses the SAME `cached` variable name for its own unrelated construction: PASS — ownership is by function, not by variable-name coincidence", () => {
      const source = `
import { getServerEnv } from "@/config/env";
let cached = null;
export function getFailedPaymentRetryCoordinator() {
  if (!cached) {
    cached = new DrizzleFailedPaymentRetryCoordinator(
      undefined, DEFAULT_RETRY_DELAY_BUSINESS_DAYS, new AuditService(new DrizzleAuditEventRepository()), undefined, getPlatformFeePolicy(), getPartialPaymentAutoApplicationService(),
      getServerEnv().PAYMENT_INITIATION_VERIFIED
    );
  }
  return cached;
}
export function getFailedPaymentRetryCoordinatorAlt() {
  if (!cached) {
    cached = new DrizzleFailedPaymentRetryCoordinator(
      undefined, DEFAULT_RETRY_DELAY_BUSINESS_DAYS, new AuditService(new DrizzleAuditEventRepository()), undefined, getPlatformFeePolicy(), getPartialPaymentAutoApplicationService(),
      true
    );
  }
  return cached;
}
`;
      expect(() => assertFactoryWiresPaymentInitiationVerified(source)).not.toThrow();
    });
  });
});
