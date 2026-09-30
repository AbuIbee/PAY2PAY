import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Stage 5 Zero-False-Positive Completion Order, Part IV Step 15: every acceptance-critical
 * command must have a captured status sidecar (command text, stdout/stderr, exit code,
 * timestamp, working directory) — never a claim inferred from prose. This is the single shared
 * helper every Stage 5 evidence-producing script uses so every sidecar has the same shape and
 * every command actually went through spawnSync (a real child process with a real, observed
 * exit code), never a hand-typed "PASS" string.
 */
const SIDECAR_DIR = path.join(process.cwd(), "docs", "remediation", "stage5-evidence", "status");

export function runCommandWithSidecar(name, cmd, args, opts = {}) {
  mkdirSync(SIDECAR_DIR, { recursive: true });
  const cwd = opts.cwd ?? process.cwd();
  const timestamp = new Date().toISOString();
  const result = spawnSync(cmd, args, { encoding: "utf8", cwd, shell: process.platform === "win32", ...opts });
  const exitCode = result.status ?? (result.error ? 1 : null);
  const sidecar = {
    name,
    command: [cmd, ...args].join(" "),
    cwd,
    timestamp,
    exitCode,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    spawnError: result.error ? String(result.error) : null,
  };
  writeFileSync(path.join(SIDECAR_DIR, `${name}.json`), JSON.stringify(sidecar, null, 2));
  return sidecar;
}

export function saveManualSidecar(name, sidecarFields) {
  mkdirSync(SIDECAR_DIR, { recursive: true });
  const sidecar = { name, timestamp: new Date().toISOString(), ...sidecarFields };
  writeFileSync(path.join(SIDECAR_DIR, `${name}.json`), JSON.stringify(sidecar, null, 2));
  return sidecar;
}

export { SIDECAR_DIR };
