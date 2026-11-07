// Layer-1 OIDC verification (test issuer, no real IdP):
//  - valid Bearer token acts as the subject-mapped principal
//    (discovery -> home -> MKCALENDAR -> PUT/GET -> cleanup)
//  - missing token / bad signature / expired / wrong issuer /
//    wrong audience / unmapped subject / malformed token -> 401
//  - another subject's token still hits principal permissions (403)
//  - IdP key rotation: a token signed with the new key passes
// Self-contained: starts the test issuer and a caldav-hono child
// server on ephemeral ports, then tears both down. Rerunnable.
// Requires seeded accounts (npm run seed). Basic regression is
// covered by scripts/verify.ts and scripts/offer-flow.ts.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestIssuer } from "./test-issuer.js";
import { ics } from "./lib.js";

const OPS = "ops-001";
const EMP = "emp-001";
const DRV = "drv-001";
const SUB_DRV = "test-subject-drv";
const SUB_OPS = "test-subject-ops";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures += 1;
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

async function waitHealth(base: string, child: ChildProcess): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})`);
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not become healthy");
}

const issuer = await startTestIssuer();
const tmp = mkdtempSync(join(tmpdir(), "caldav-oidc-"));
const configPath = join(tmp, "oidc.local.json");
writeFileSync(configPath, JSON.stringify({
  issuer: issuer.issuer,
  audience: issuer.audience,
  jwksUrl: issuer.jwksUrl,
  subjects: { [SUB_DRV]: DRV, [SUB_OPS]: OPS },
}), { mode: 0o600 });

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["dist/src/index.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    CALDAV_OIDC_CONFIG: configPath,
    // Short JWKS cache timings so the rotation check stays fast.
    CALDAV_OIDC_JWKS_COOLDOWN_MS: "0",
    CALDAV_OIDC_JWKS_CACHE_MAX_AGE_MS: "1000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr?.on("data", (b: Buffer) => process.stderr.write(`[server] ${b}`));

interface Res { status: number; body: string; wwwAuth: string | null; }
async function req(method: string, path: string, token: string | null, body?: string): Promise<Res> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": method === "PUT" ? "text/calendar; charset=utf-8" : "application/xml; charset=utf-8" } : {}),
    },
    body,
    redirect: "manual",
  });
  return { status: res.status, body: await res.text(), wwwAuth: res.headers.get("www-authenticate") };
}

const run = Date.now().toString(36);
const calPath = `/calendars/${DRV}/oidc-verify-${run}/`;

try {
  await waitHealth(BASE, server);
  check("healthz (OIDC enabled server)", true);

  const drvToken = await issuer.sign({ sub: SUB_DRV });
  const opsToken = await issuer.sign({ sub: SUB_OPS });

  const noTok = await req("PROPFIND", "/dav/cal/", null, "<D:propfind xmlns:D=\"DAV:\"><D:allprop/></D:propfind>");
  check("no token -> 401", noTok.status === 401, `http=${noTok.status}`);
  check("401 advertises Bearer", (noTok.wwwAuth ?? "").includes("Bearer"), `www-authenticate=${noTok.wwwAuth}`);

  const discovery = await req("PROPFIND", "/dav/cal/", drvToken, "<D:propfind xmlns:D=\"DAV:\"><D:prop><D:current-user-principal/></D:prop></D:propfind>");
  check("valid token: discovery as mapped principal", discovery.status === 207 && discovery.body.includes(`/principals/${DRV}/`), `http=${discovery.status}`);

  const home = await req("PROPFIND", `/calendars/${DRV}/`, drvToken, "<D:propfind xmlns:D=\"DAV:\"><D:allprop/></D:propfind>");
  check("valid token: own home 207", home.status === 207, `http=${home.status}`);

  const mk = await req("MKCALENDAR", calPath, drvToken,
    "<C:mkcalendar xmlns:D=\"DAV:\" xmlns:C=\"urn:ietf:params:xml:ns:caldav\"><D:set><D:prop><D:displayname>OIDC検証</D:displayname></D:prop></D:set></C:mkcalendar>");
  check("valid token: MKCALENDAR 201", mk.status === 201, `http=${mk.status}`);

  const evPath = `${calPath}oidc-ev-${run}.ics`;
  const put = await req("PUT", evPath, drvToken,
    ics({ uid: `oidc-ev-${run}@caldav-hono`, start: "20261108T110000Z", end: "20261108T120000Z", summary: "OIDC検証予定" }));
  check("valid token: PUT 201", put.status === 201, `http=${put.status}`);

  const get = await req("GET", evPath, drvToken);
  check("valid token: GET round-trip", get.status === 200 && get.body.includes("OIDC検証予定"), `http=${get.status}`);

  // --- rejection cases ---------------------------------------------------
  const badSig = await req("PROPFIND", "/dav/cal/", await issuer.sign({ sub: SUB_DRV, rogue: true }), "");
  check("bad signature -> 401", badSig.status === 401, `http=${badSig.status}`);

  const expired = await req("PROPFIND", "/dav/cal/", await issuer.sign({ sub: SUB_DRV, expiresInSec: -120 }), "");
  check("expired token -> 401", expired.status === 401, `http=${expired.status}`);

  const badIss = await req("PROPFIND", "/dav/cal/", await issuer.sign({ sub: SUB_DRV, issuer: "http://127.0.0.1:1/oidc" }), "");
  check("wrong issuer -> 401", badIss.status === 401, `http=${badIss.status}`);

  const badAud = await req("PROPFIND", "/dav/cal/", await issuer.sign({ sub: SUB_DRV, audience: "other-audience" }), "");
  check("wrong audience -> 401", badAud.status === 401, `http=${badAud.status}`);

  const noScope = await req("PROPFIND", "/dav/cal/", await issuer.sign({ sub: SUB_DRV, scope: "openid profile" }), "");
  check("missing caldav scope -> 401", noScope.status === 401, `http=${noScope.status}`);

  const unmapped = await req("PROPFIND", "/dav/cal/", await issuer.sign({ sub: "no-such-subject" }), "");
  check("unmapped subject -> 401", unmapped.status === 401, `http=${unmapped.status}`);

  const malformed = await req("PROPFIND", "/dav/cal/", "not-a-jwt", "");
  check("malformed token -> 401", malformed.status === 401, `http=${malformed.status}`);

  // --- permissions stay principal-based ----------------------------------
  const otherHome = await req("PROPFIND", `/calendars/${EMP}/`, drvToken, "");
  check("drv token vs emp home -> 403", otherHome.status === 403, `http=${otherHome.status}`);

  const stageWrite = await req("PUT", `/calendars/${OPS}/stage-booked/oidc-nope-${run}.ics`, drvToken,
    ics({ uid: `oidc-nope-${run}@caldav-hono`, start: "20261108T110000Z", end: "20261108T120000Z", summary: "nope" }));
  check("drv token write to stage calendar -> 403", stageWrite.status === 403, `http=${stageWrite.status}`);

  const opsHome = await req("PROPFIND", `/calendars/${OPS}/`, opsToken, "");
  check("ops token maps to ops principal", opsHome.status === 207, `http=${opsHome.status}`);

  // --- key rotation -------------------------------------------------------
  await issuer.rotate();
  const rotatedToken = await issuer.sign({ sub: SUB_DRV });
  let rotated = await req("PROPFIND", "/dav/cal/", rotatedToken, "");
  for (let i = 0; i < 20 && rotated.status !== 207; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    rotated = await req("PROPFIND", "/dav/cal/", rotatedToken, "");
  }
  check("token signed with rotated key passes", rotated.status === 207, `http=${rotated.status}`);

  // --- cleanup -------------------------------------------------------------
  const delEv = await req("DELETE", evPath, rotatedToken);
  const delCal = await req("DELETE", calPath, rotatedToken);
  check("cleanup: delete event+calendar", delEv.status === 204 && delCal.status === 204, `ev=${delEv.status} cal=${delCal.status}`);
} finally {
  server.kill("SIGTERM");
  await issuer.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "VERIFY-OIDC: ALL PASS" : `VERIFY-OIDC: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
