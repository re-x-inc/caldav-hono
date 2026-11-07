// Single E2E entry point (Zuul check/gate shape): one command runs every
// verification suite against an isolated, throwaway server and reports
// one exit code.
//
//   npm run verify:e2e          # = tsc && node dist/scripts/verify-e2e.js
//
// What it does:
//  1. temp dir; isolated child server on a free 127.0.0.1 port
//     (CALDAV_DATA / CALDAV_ACCOUNTS under the temp dir, CALDAV_STORE=sqlite,
//     OIDC / admin config pointed at missing files so nothing from
//     config/*.local.json leaks in). The shared 5232 instance is never touched.
//  2. seed (ops-001 / emp-001 / drv-001) into the temp data area
//  3. server-backed suites against that server via CALDAV_BASE:
//     verify, offer-flow, verify-recurrence
//  4. self-contained suites (they spawn their own servers on ephemeral
//     ports): verify-scheduling, verify-admin, verify-offer-dedupe, verify-oidc
//  5. per-suite PASS/FAIL counts + total; exit 1 if any suite fails
//  6. stop the server, remove the temp dir
//
// tsc runs exactly once (in the npm script, before this runner); every
// suite is executed from dist/ directly, so the type check is the build.
// The existing suites are untouched.
//
// Env knobs:
//   CALDAV_E2E_KEEP=1            keep the temp dir when a suite fails (path is printed)
//   CALDAV_E2E_SUITE_TIMEOUT_MS  per-suite timeout (default 600000)
//   CALDAV_E2E_ONLY=a,b          run only the named suites (debugging)

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Suite { name: string; script: string; kind: "server" | "self"; }

const SUITES: Suite[] = [
  { name: "verify", script: "dist/scripts/verify.js", kind: "server" },
  { name: "offer-flow", script: "dist/scripts/offer-flow.js", kind: "server" },
  { name: "verify-recurrence", script: "dist/scripts/verify-recurrence.js", kind: "server" },
  { name: "verify-scheduling", script: "dist/scripts/verify-scheduling.js", kind: "self" },
  { name: "verify-admin", script: "dist/scripts/verify-admin.js", kind: "self" },
  { name: "verify-offer-dedupe", script: "dist/scripts/verify-offer-dedupe.js", kind: "self" },
  { name: "verify-oidc", script: "dist/scripts/verify-oidc.js", kind: "self" },
];

interface SuiteResult { name: string; ok: boolean; pass: number; fail: number; ms: number; note: string; }

const KEEP = process.env.CALDAV_E2E_KEEP === "1";
const SUITE_TIMEOUT_MS = Number(process.env.CALDAV_E2E_SUITE_TIMEOUT_MS ?? "600000");
const ONLY = (process.env.CALDAV_E2E_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const t0 = Date.now();
const log = (msg: string) => console.log(`[e2e] ${msg}`);
const secs = (ms: number) => (ms / 1000).toFixed(1) + "s";

for (const s of SUITES) {
  if (!existsSync(s.script)) {
    console.error(`[e2e] missing ${s.script}: run tsc first (npm run verify:e2e does)`);
    process.exit(2);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") return reject(new Error("no free port"));
      s.close(() => resolve(addr.port));
    });
    s.on("error", reject);
  });
}

async function waitHealth(base: string, child: ChildProcess, serverLog: () => string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${serverLog()}`);
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not become healthy: ${serverLog()}`);
}

function stop(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

// --- isolated environment ----------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "caldav-e2e-"));
const dataDir = join(tmp, "data");
const accountsPath = join(tmp, "accounts.local.json");
const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;

// Inherit the caller's env (PATH etc.) but pin everything caldav-hono reads
// so a developer's local config and the shared instance stay out of the run.
const env: NodeJS.ProcessEnv = {
  ...process.env,
  CALDAV_STORE: "sqlite",
  CALDAV_DATA: dataDir,
  CALDAV_ACCOUNTS: accountsPath,
  CALDAV_BASE: BASE,
  CALDAV_OIDC_CONFIG: join(tmp, "no-oidc.json"),
  CALDAV_ADMIN_CONFIG: join(tmp, "no-admin.json"),
};
for (const k of ["CALDAV_DB", "CALDAV_ADMIN_TOKEN", "CALDAV_OIDC_ISSUER", "CALDAV_OIDC_AUDIENCE", "CALDAV_OIDC_JWKS_URL",
  "CALDAV_OIDC_ADMIN_CLAIM", "CALDAV_OIDC_ADMIN_VALUE", "CALDAV_INBOX_RETENTION_DAYS", "PORT", "HOST"]) {
  delete env[k];
}

let server: ChildProcess | null = null;
let serverLog = "";
const results: SuiteResult[] = [];
let aborted = false;

async function runSuite(s: Suite): Promise<SuiteResult> {
  const start = Date.now();
  log(`--- ${s.name} (${s.kind === "server" ? `CALDAV_BASE=${BASE}` : "self-contained"}) ---`);
  return new Promise((resolve) => {
    let pass = 0;
    let fail = 0;
    let note = "";
    const child = spawn(process.execPath, [s.script], {
      env, stdio: ["ignore", "pipe", "pipe"], timeout: SUITE_TIMEOUT_MS, killSignal: "SIGKILL",
    });
    let buf = "";
    const onLine = (line: string) => {
      if (line.startsWith("PASS ")) pass += 1;
      else if (line.startsWith("FAIL ")) fail += 1;
      console.log(`[${s.name}] ${line}`);
    };
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) onLine(l);
    });
    child.stderr.on("data", (d: Buffer) => process.stderr.write(`[${s.name}:stderr] ${d}`));
    child.on("close", (code, signal) => {
      if (buf) onLine(buf);
      if (signal) note = `killed by ${signal}${signal === "SIGKILL" ? " (timeout?)" : ""}`;
      else if (code !== 0) note = `exit ${code}`;
      const ok = code === 0 && signal === null;
      const ms = Date.now() - start;
      log(`${ok ? "PASS" : "FAIL"} ${s.name}: ${pass} pass / ${fail} fail in ${secs(ms)}${note ? ` (${note})` : ""}`);
      resolve({ name: s.name, ok, pass, fail, ms, note });
    });
  });
}

async function cleanup(): Promise<void> {
  await stop(server);
  const failed = results.some((r) => !r.ok) || aborted;
  if (failed && KEEP) log(`kept temp dir: ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    aborted = true;
    log(`${sig}: stopping`);
    void cleanup().then(() => process.exit(130));
  });
}

try {
  log(`temp dir ${tmp}`);
  log(`seed -> ${dataDir}`);
  const seeded = spawnSync(process.execPath, ["dist/scripts/seed.js"], { env, encoding: "utf8" });
  if (seeded.status !== 0) {
    console.error(seeded.stdout, seeded.stderr);
    throw new Error(`seed failed (exit ${seeded.status})`);
  }
  for (const l of seeded.stdout.trim().split("\n")) console.log(`[seed] ${l}`);

  server = spawn(process.execPath, ["dist/src/index.js"], {
    env: { ...env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (d) => { serverLog += String(d); });
  server.stderr?.on("data", (d) => { serverLog += String(d); });
  await waitHealth(BASE, server, () => serverLog);
  log(`isolated server up at ${BASE} (pid ${server.pid})`);

  for (const s of SUITES) {
    if (ONLY.length && !ONLY.includes(s.name)) continue;
    if (aborted) break;
    results.push(await runSuite(s));
  }
} catch (e) {
  results.push({ name: "setup", ok: false, pass: 0, fail: 1, ms: Date.now() - t0, note: e instanceof Error ? e.message : String(e) });
} finally {
  await cleanup();
}

// --- summary -----------------------------------------------------------------
const totalPass = results.reduce((n, r) => n + r.pass, 0);
const totalFail = results.reduce((n, r) => n + r.fail, 0);
const failedSuites = results.filter((r) => !r.ok);
console.log("");
console.log("E2E SUMMARY (typecheck+build: tsc, once, before this runner)");
console.log("  suite                 result  pass  fail  time");
for (const r of results) {
  console.log(`  ${r.name.padEnd(21)} ${(r.ok ? "PASS" : "FAIL").padEnd(7)} ${String(r.pass).padStart(4)}  ${String(r.fail).padStart(4)}  ${secs(r.ms).padStart(6)}${r.note ? `  ${r.note}` : ""}`);
}
console.log(`  ${"total".padEnd(21)} ${(failedSuites.length === 0 ? "PASS" : "FAIL").padEnd(7)} ${String(totalPass).padStart(4)}  ${String(totalFail).padStart(4)}  ${secs(Date.now() - t0).padStart(6)}`);
if (failedSuites.length > 0 && serverLog) console.log("--- isolated server log (tail) ---\n" + serverLog.slice(-3000));
console.log(failedSuites.length === 0
  ? `VERIFY-E2E: ALL PASS (${results.length} suites, ${totalPass} checks)`
  : `VERIFY-E2E: ${failedSuites.length} SUITE(S) FAILED (${failedSuites.map((r) => r.name).join(", ")})`);
process.exit(failedSuites.length === 0 ? 0 : 1);
