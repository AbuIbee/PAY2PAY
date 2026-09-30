# Stage 5 Authoritative Final Evidence Manifest — V2 (source-freeze corrected)

Generated: 2026-09-30T01:24:07.597Z

Supersedes `authoritative-final/manifest.json`/`manifest.md` — see the closure report for why.

## Required steps (in execution order)

1. `01-schema-parity-and-index-extraction` — command.txt, stdout.txt, stderr.txt, status.json
2. `02-verifier-self-validation` — command.txt, stdout.txt, stderr.txt, status.json
3. `03-forward-upgrade` — command.txt, stdout.txt, stderr.txt, status.json
4. `04-migration-runner-proof` — command.txt, stdout.txt, stderr.txt, status.json
5. `05-stage4-regression` — command.txt, stdout.txt, stderr.txt, status.json
6. `06-typecheck` — command.txt, stdout.txt, stderr.txt, status.json
7. `07-lint` — command.txt, stdout.txt, stderr.txt, status.json
8. `08-broader-regression-run-1` — command.txt, stdout.txt, stderr.txt, status.json
9. `09-broader-regression-run-2` — command.txt, stdout.txt, stderr.txt, status.json
10. `10-broader-regression-run-3` — command.txt, stdout.txt, stderr.txt, status.json

## Artifact existence

| Artifact | Label | Exists |
|---|---|---|
| `docs/remediation/stage5-evidence/authoritative-final-v2/source-freeze.json` | pre-campaign source freeze (NUL-delimited git discovery, hashes, HEAD, coverage) | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/source-freeze-after.json` | post-campaign, INDEPENDENTLY re-derived source freeze | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/source-freeze-drift.json` | before/after drift comparison (path-set, existence-state, content-hash, curated, migrations, CI workflow) | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/campaign-summary.json` | top-level campaign result | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/git-tracked-changed-raw-before.txt` | raw `git diff --name-only -z HEAD --` output, pre-campaign | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/git-untracked-raw-before.txt` | raw `git ls-files --others --exclude-standard -z` output, pre-campaign | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/git-tracked-changed-raw-after.txt` | raw tracked-changed output, post-campaign | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/git-untracked-raw-after.txt` | raw untracked output, post-campaign | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/changed-path-list-before.json` | final unioned, filtered changed-path list, pre-campaign | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/changed-path-list-after.json` | final unioned, filtered changed-path list, post-campaign | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/deployment-ordering.md` | G5-10 authoritative deployment-ordering evidence | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/provider-boundary-check.txt` | provider-boundary evidence | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/pre-push-inventory-git-status.txt` | pre-push inventory | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/adversarial-preflight.md` | Codex-style adversarial preflight, including the freeze-logic-specific RULE 18 attack | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/01-schema-parity-and-index-extraction.command.txt` | 01-schema-parity-and-index-extraction: command text | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/01-schema-parity-and-index-extraction.stdout.txt` | 01-schema-parity-and-index-extraction: captured stdout | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/01-schema-parity-and-index-extraction.stderr.txt` | 01-schema-parity-and-index-extraction: captured stderr | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/01-schema-parity-and-index-extraction.status.json` | 01-schema-parity-and-index-extraction: status sidecar | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/02-verifier-self-validation.command.txt` | 02-verifier-self-validation: command text | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/02-verifier-self-validation.stdout.txt` | 02-verifier-self-validation: captured stdout | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/02-verifier-self-validation.stderr.txt` | 02-verifier-self-validation: captured stderr | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/02-verifier-self-validation.status.json` | 02-verifier-self-validation: status sidecar | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/03-forward-upgrade.command.txt` | 03-forward-upgrade: command text | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/03-forward-upgrade.stdout.txt` | 03-forward-upgrade: captured stdout | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/03-forward-upgrade.stderr.txt` | 03-forward-upgrade: captured stderr | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/03-forward-upgrade.status.json` | 03-forward-upgrade: status sidecar | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/04-migration-runner-proof.command.txt` | 04-migration-runner-proof: command text | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/04-migration-runner-proof.stdout.txt` | 04-migration-runner-proof: captured stdout | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/04-migration-runner-proof.stderr.txt` | 04-migration-runner-proof: captured stderr | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/04-migration-runner-proof.status.json` | 04-migration-runner-proof: status sidecar | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/05-stage4-regression.command.txt` | 05-stage4-regression: command text | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/05-stage4-regression.stdout.txt` | 05-stage4-regression: captured stdout | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/05-stage4-regression.stderr.txt` | 05-stage4-regression: captured stderr | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/05-stage4-regression.status.json` | 05-stage4-regression: status sidecar | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/06-typecheck.command.txt` | 06-typecheck: command text | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/06-typecheck.stdout.txt` | 06-typecheck: captured stdout | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/06-typecheck.stderr.txt` | 06-typecheck: captured stderr | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/06-typecheck.status.json` | 06-typecheck: status sidecar | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/07-lint.command.txt` | 07-lint: command text | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/07-lint.stdout.txt` | 07-lint: captured stdout | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/07-lint.stderr.txt` | 07-lint: captured stderr | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/07-lint.status.json` | 07-lint: status sidecar | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/08-broader-regression-run-1.command.txt` | 08-broader-regression-run-1: command text | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/08-broader-regression-run-1.stdout.txt` | 08-broader-regression-run-1: captured stdout | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/08-broader-regression-run-1.stderr.txt` | 08-broader-regression-run-1: captured stderr | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/08-broader-regression-run-1.status.json` | 08-broader-regression-run-1: status sidecar | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/09-broader-regression-run-2.command.txt` | 09-broader-regression-run-2: command text | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/09-broader-regression-run-2.stdout.txt` | 09-broader-regression-run-2: captured stdout | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/09-broader-regression-run-2.stderr.txt` | 09-broader-regression-run-2: captured stderr | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/09-broader-regression-run-2.status.json` | 09-broader-regression-run-2: status sidecar | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/10-broader-regression-run-3.command.txt` | 10-broader-regression-run-3: command text | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/10-broader-regression-run-3.stdout.txt` | 10-broader-regression-run-3: captured stdout | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/10-broader-regression-run-3.stderr.txt` | 10-broader-regression-run-3: captured stderr | YES |
| `docs/remediation/stage5-evidence/authoritative-final-v2/10-broader-regression-run-3.status.json` | 10-broader-regression-run-3: status sidecar | YES |

## CI workflow freeze coverage

```
CI WORKFLOW FREEZE COVERAGE: PASS
```

## Freeze integrity result

```
SOURCE FREEZE INTEGRITY VALIDATION: PASS
```

## Overall manifest validation

```
AUTHORITATIVE V2 EVIDENCE MANIFEST VALIDATION: PASS
```
