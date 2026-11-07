// Admin plane verification (next-stage order Part C):
//  - /admin never opens without the admin credential (no auth, CalDAV
//    Basic principal credentials, wrong token -> 401; unconfigured -> 503;
//    file store -> 501)
//  - create drv-002 (auto ID) through the admin plane only, then that
//    principal does CalDAV discovery -> list -> PUT/GET
//  - initial calendar set: default + avail + inbox, read grants on the
//    ops stage calendars, ops reads the new avail
//  - OIDC subject mapping from the principals table, admin via OIDC
//    admin claim
//  - credential reset, ACL grant/revoke, disable -> 403, enable,
//    delete -> 401 and the calendars are gone for everyone
// Self-contained: temp SQLite data area, spawned servers on ephemeral
// ports, test OIDC issuer. Rerunnable.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestIssuer } from "./test-issuer.js";

const OPS = "ops-001";
const EMP = "emp-001";
const DRV = "drv-001";
const ADMIN_TOKEN = "verify-admin-token-" + Date.now().toString(36);

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

const issuer = await startTestIssuer();
const tmp = mkdtempSync(join(tmpdir(), "caldav-admin-"));
const dataDir = join(tmp, "data");
const accountsPath = join(tmp, "accounts.json");
const oidcPath = join(tmp, "oidc.json");
writeFileSync(accountsPath, JSON.stringify({
  accounts: [
    { username: OPS, password: "pw-ops", email: `${OPS}@example.test`, displayName: "Operator" },
    { username: EMP, password: "pw-emp", email: `${EMP}@example.test`, displayName: "Employee" },
    { username: DRV, password: "pw-drv", email: `${DRV}@example.test`, displayName: "Driver" },
  ],
}, null, 2) + "\n", { mode: 0o600 });
writeFileSync(oidcPath, JSON.stringify({
  issuer: issuer.issuer, audience: issuer.audience, jwksUrl: issuer.jwksUrl,
  subjects: {}, adminClaim: "roles", adminValue: "caldav-admin",
}), { mode: 0o600 });

const baseEnv = { ...process.env, CALDAV_DATA: dataDir, CALDAV_ACCOUNTS: accountsPath, CALDAV_STORE: "sqlite" };
delete (baseEnv as Record<string, string | undefined>).CALDAV_ADMIN_TOKEN;
const seeded = spawnSync(process.execPath, ["dist/scripts/seed.js"], { env: baseEnv, encoding: "utf8" });
if (seeded.status !== 0) {
  console.error(seeded.stdout, seeded.stderr);
  throw new Error("seed failed");
}

let serverLog = "";
function startServer(extraEnv: Record<string, string>, port: number): ChildProcess {
  const child = spawn(process.execPath, ["dist/src/index.js"], {
    env: { ...baseEnv, PORT: String(port), HOST: "127.0.0.1", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => { serverLog += String(d); });
  child.stderr?.on("data", (d) => { serverLog += String(d); });
  return child;
}

async function waitHealth(base: string, child: ChildProcess): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${serverLog}`);
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not become healthy");
}

interface Res { status: number; body: string; etag: string | null; json: Record<string, unknown> | null }
async function raw(base: string, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Res> {
  const res = await fetch(base + path, { method, headers, body, redirect: "manual" });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* not json */ }
  return { status: res.status, body: text, etag: res.headers.get("etag"), json };
}

const PW: Record<string, string> = { [OPS]: "pw-ops", [EMP]: "pw-emp", [DRV]: "pw-drv" };
function basic(user: string): string {
  return "Basic " + Buffer.from(`${user}:${PW[user]}`).toString("base64");
}
function dav(base: string, user: string, method: string, path: string, opts: { body?: string; headers?: Record<string, string> } = {}) {
  return raw(base, method, path, {
    Authorization: basic(user),
    ...(opts.body ? { "Content-Type": method === "PUT" ? "text/calendar; charset=utf-8" : "application/xml; charset=utf-8" } : {}),
    ...(opts.headers ?? {}),
  }, opts.body);
}
function admin(base: string, method: string, path: string, body?: unknown, token = ADMIN_TOKEN) {
  return raw(base, method, `/admin${path}`, {
    Authorization: `Bearer ${token}`,
    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
  }, body !== undefined ? JSON.stringify(body) : undefined);
}

const ALLPROP = '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>';
function ics(uid: string, summary: string): string {
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//caldav-hono//verify-admin//EN",
    "BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20261107T000000Z",
    "DTSTART:20261115T110000Z", "DTEND:20261115T120000Z", `SUMMARY:${summary}`,
    "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
}

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const server = startServer({ CALDAV_ADMIN_TOKEN: ADMIN_TOKEN, CALDAV_OIDC_CONFIG: oidcPath }, port);
let unconfigured: ChildProcess | null = null;
let fileMode: ChildProcess | null = null;

try {
  await waitHealth(BASE, server);
  check("healthz (spawned sqlite server with admin token)", true, BASE);

  // --- the plane is closed without the admin credential --------------------
  const noAuth = await raw(BASE, "GET", "/admin/principals", {});
  check("admin: no credential -> 401", noAuth.status === 401, `http=${noAuth.status}`);
  const principalCreds = await raw(BASE, "GET", "/admin/principals", { Authorization: basic(OPS) });
  check("admin: CalDAV Basic principal credential -> 401", principalCreds.status === 401, `http=${principalCreds.status}`);
  const wrongTok = await admin(BASE, "GET", "/principals", undefined, "not-the-token");
  check("admin: wrong token -> 401", wrongTok.status === 401, `http=${wrongTok.status}`);
  const caldavWithAdminTok = await raw(BASE, "PROPFIND", "/dav/cal/", { Authorization: `Bearer ${ADMIN_TOKEN}` }, ALLPROP);
  check("admin token is not a CalDAV credential (PROPFIND -> 401)", caldavWithAdminTok.status === 401, `http=${caldavWithAdminTok.status}`);

  const list0 = await admin(BASE, "GET", "/principals");
  const names0 = ((list0.json?.principals ?? []) as { username: string }[]).map((p) => p.username);
  check("admin: list seeded principals", list0.status === 200 && names0.includes(OPS) && names0.includes(DRV), names0.join(","));

  // --- create drv-002 through the admin plane only --------------------------
  const created = await admin(BASE, "POST", "/principals", { kind: "drv", displayName: "jiro" });
  const drv2 = (created.json?.principal as { username: string; email: string; status: string } | undefined);
  const drv2Pw = created.json?.password as string | undefined;
  check("admin: POST kind=drv allocates drv-002 + one-time password", created.status === 201 && drv2?.username === "drv-002" && !!drv2Pw, `http=${created.status} username=${drv2?.username}`);
  const prov = created.json?.provision as { owned: string[]; granted: string[] } | undefined;
  check("admin: initial set default+avail+inbox, reads ops stage calendars",
    !!prov && ["default", "avail", "inbox"].every((x) => prov.owned.includes(x)) && prov.granted.includes(`${OPS}/stage-request`),
    `owned=${prov?.owned.join(",")} granted=${prov?.granted.join(",")}`);
  PW["drv-002"] = drv2Pw ?? "";

  const dup = await admin(BASE, "POST", "/principals", { username: "drv-002" });
  check("admin: duplicate username -> 409", dup.status === 409, `http=${dup.status}`);
  const badName = await admin(BASE, "POST", "/principals", { username: "driver2" });
  check("admin: malformed username -> 400", badName.status === 400, `http=${badName.status}`);

  // --- drv-002 uses CalDAV: discovery -> list -> PUT/GET ----------------------
  const disc = await dav(BASE, "drv-002", "PROPFIND", "/dav/cal/", { body: ALLPROP });
  check("drv-002: current-user-principal", disc.status === 207 && disc.body.includes("/principals/drv-002/"), `http=${disc.status}`);
  const home = await dav(BASE, "drv-002", "PROPFIND", "/calendars/drv-002/", { headers: { Depth: "1" }, body: ALLPROP });
  check("drv-002: home lists default + avail + shared stage calendars, not inbox",
    home.status === 207 && home.body.includes("/calendars/drv-002/default/") && home.body.includes("/calendars/drv-002/avail/") &&
    home.body.includes(`/calendars/${OPS}/stage-booked/`) && !home.body.includes("/calendars/drv-002/inbox/"),
    `http=${home.status}`);
  const putEv = await dav(BASE, "drv-002", "PUT", "/calendars/drv-002/default/admin-ev1.ics", { body: ics("admin-ev1@caldav-hono", "drv-002 予定") });
  const getEv = await dav(BASE, "drv-002", "GET", "/calendars/drv-002/default/admin-ev1.ics");
  check("drv-002: PUT 201 + GET 200", putEv.status === 201 && getEv.status === 200 && getEv.body.includes("drv-002 予定"), `put=${putEv.status} get=${getEv.status}`);
  const stageWrite = await dav(BASE, "drv-002", "PUT", `/calendars/${OPS}/stage-booked/nope.ics`, { body: ics("nope@caldav-hono", "nope") });
  check("drv-002: stage calendar is read-only (403)", stageWrite.status === 403, `http=${stageWrite.status}`);
  const opsSeesAvail = await dav(BASE, OPS, "PROPFIND", "/calendars/drv-002/avail/", { body: ALLPROP });
  check("ops-001 reads drv-002/avail (initial grant)", opsSeesAvail.status === 207, `http=${opsSeesAvail.status}`);
  const opsDirect = await dav(BASE, OPS, "PUT", "/calendars/drv-002/default/direct.ics", { body: ics("direct@caldav-hono", "direct") });
  check("ops-001 cannot direct-write drv-002/default (delivery only) -> 403", opsDirect.status === 403, `http=${opsDirect.status}`);

  // --- ops-002: stage calendars with readers = every emp/drv -----------------
  const ops2 = await admin(BASE, "POST", "/principals", { kind: "ops", displayName: "ops two" });
  const ops2Cals = await admin(BASE, "GET", "/principals/ops-002/calendars");
  const stageReq = ((ops2Cals.json?.calendars ?? []) as { id: string; readers: string[] }[]).find((c) => c.id === "stage-request");
  check("admin: ops-002 stage-request readers include emp-001, drv-001, drv-002",
    ops2.status === 201 && !!stageReq && [EMP, DRV, "drv-002"].every((u) => stageReq.readers.includes(u)),
    `readers=${stageReq?.readers.join(",")}`);

  // --- OIDC subject mapping lives in the principals table ---------------------
  const subTok = await issuer.sign({ sub: "idp-sub-drv-002" });
  const beforeMap = await raw(BASE, "PROPFIND", "/dav/cal/", { Authorization: `Bearer ${subTok}` }, ALLPROP);
  check("OIDC: unmapped subject -> 401", beforeMap.status === 401, `http=${beforeMap.status}`);
  const patched = await admin(BASE, "PATCH", "/principals/drv-002", { oidcSubject: "idp-sub-drv-002", displayName: "jiro-2" });
  const afterMap = await raw(BASE, "PROPFIND", "/dav/cal/", { Authorization: `Bearer ${subTok}` }, ALLPROP);
  check("OIDC: subject mapped via admin PATCH -> token acts as drv-002",
    patched.status === 200 && afterMap.status === 207 && afterMap.body.includes("/principals/drv-002/"), `patch=${patched.status} http=${afterMap.status}`);
  const got = await admin(BASE, "GET", "/principals/drv-002");
  check("admin: GET reflects displayName + oidcSubject", (got.json?.principal as { displayName: string; oidcSubject: string })?.displayName === "jiro-2" &&
    (got.json?.principal as { oidcSubject: string })?.oidcSubject === "idp-sub-drv-002");

  // --- admin via OIDC admin claim -----------------------------------------------
  const adminClaimTok = await issuer.sign({ sub: "idp-admin", claims: { roles: ["caldav-admin"] } });
  const viaClaim = await admin(BASE, "GET", "/principals", undefined, adminClaimTok);
  check("admin: OIDC token with admin claim -> 200", viaClaim.status === 200, `http=${viaClaim.status}`);
  const noClaimTok = await issuer.sign({ sub: "idp-sub-drv-002" });
  const viaNoClaim = await admin(BASE, "GET", "/principals", undefined, noClaimTok);
  check("admin: OIDC principal token without admin claim -> 401", viaNoClaim.status === 401, `http=${viaNoClaim.status}`);

  // --- credential reset -------------------------------------------------------------
  const oldPw = PW["drv-002"];
  const reset = await admin(BASE, "POST", "/principals/drv-002/password");
  const newPw = reset.json?.password as string | undefined;
  const oldFails = await dav(BASE, "drv-002", "PROPFIND", "/dav/cal/", { body: ALLPROP });
  PW["drv-002"] = newPw ?? "";
  const newWorks = await dav(BASE, "drv-002", "PROPFIND", "/dav/cal/", { body: ALLPROP });
  check("admin: password reset -> old 401, new 207", reset.status === 200 && !!newPw && newPw !== oldPw && oldFails.status === 401 && newWorks.status === 207,
    `old=${oldFails.status} new=${newWorks.status}`);

  // --- ACL grant / revoke --------------------------------------------------------------
  const grant = await admin(BASE, "PUT", `/calendars/drv-002/default/acl/${OPS}`, { access: "write" });
  const opsWrite = await dav(BASE, OPS, "PUT", "/calendars/drv-002/default/granted.ics", { body: ics("granted@caldav-hono", "granted") });
  check("admin: grant ops-001 write on drv-002/default -> PUT 201", grant.status === 200 && opsWrite.status === 201, `grant=${grant.status} put=${opsWrite.status}`);
  const revoke = await admin(BASE, "DELETE", `/calendars/drv-002/default/acl/${OPS}`);
  const opsWrite2 = await dav(BASE, OPS, "PUT", "/calendars/drv-002/default/granted2.ics", { body: ics("granted2@caldav-hono", "granted2") });
  check("admin: revoke -> PUT 403", revoke.status === 200 && opsWrite2.status === 403, `revoke=${revoke.status} put=${opsWrite2.status}`);

  // --- disable / enable ------------------------------------------------------------------
  const disable = await admin(BASE, "POST", "/principals/drv-002/disable");
  const disabledBasic = await dav(BASE, "drv-002", "PROPFIND", "/dav/cal/", { body: ALLPROP });
  const disabledBearer = await raw(BASE, "PROPFIND", "/dav/cal/", { Authorization: `Bearer ${subTok}` }, ALLPROP);
  check("admin: disabled principal -> 403 (Basic and Bearer)", disable.status === 200 && disabledBasic.status === 403 && disabledBearer.status === 403,
    `basic=${disabledBasic.status} bearer=${disabledBearer.status}`);
  const enable = await admin(BASE, "POST", "/principals/drv-002/enable");
  const enabledAgain = await dav(BASE, "drv-002", "PROPFIND", "/dav/cal/", { body: ALLPROP });
  check("admin: enable -> 207 again", enable.status === 200 && enabledAgain.status === 207, `http=${enabledAgain.status}`);

  // --- delete ------------------------------------------------------------------------------
  const del = await admin(BASE, "DELETE", "/principals/drv-002");
  const gone = await dav(BASE, "drv-002", "PROPFIND", "/dav/cal/", { body: ALLPROP });
  const opsHome = await dav(BASE, OPS, "PROPFIND", `/calendars/${OPS}/`, { headers: { Depth: "1" }, body: ALLPROP });
  const availGone = await dav(BASE, OPS, "PROPFIND", "/calendars/drv-002/avail/", { body: ALLPROP });
  check("admin: delete -> principal 401, calendars invisible (home) and 404",
    del.status === 204 && gone.status === 401 && !opsHome.body.includes("/calendars/drv-002/") && availGone.status === 404,
    `del=${del.status} auth=${gone.status} avail=${availGone.status}`);
  const ops2Cals2 = await admin(BASE, "GET", "/principals/ops-002/calendars");
  const stageReq2 = ((ops2Cals2.json?.calendars ?? []) as { id: string; readers: string[] }[]).find((c) => c.id === "stage-request");
  check("admin: deleted principal's grants removed from ops-002 stage-request", !!stageReq2 && !stageReq2.readers.includes("drv-002"), `readers=${stageReq2?.readers.join(",")}`);
  const realloc = await admin(BASE, "POST", "/principals", { kind: "drv" });
  check("admin: next drv ID after delete is drv-003 (numbers are not reused)", (realloc.json?.principal as { username: string })?.username === "drv-003");

  // --- unconfigured plane and file store ----------------------------------------------------
  const port2 = await freePort();
  unconfigured = startServer({ CALDAV_OIDC_CONFIG: join(tmp, "missing.json") }, port2);
  await waitHealth(`http://127.0.0.1:${port2}`, unconfigured);
  const unconf = await raw(`http://127.0.0.1:${port2}`, "GET", "/admin/principals", { Authorization: `Bearer ${ADMIN_TOKEN}` });
  check("admin: no token and no OIDC admin claim configured -> 503, never open", unconf.status === 503, `http=${unconf.status}`);

  const port3 = await freePort();
  fileMode = startServer({ CALDAV_STORE: "file", CALDAV_ADMIN_TOKEN: ADMIN_TOKEN, CALDAV_DATA: join(tmp, "data-file") }, port3);
  await waitHealth(`http://127.0.0.1:${port3}`, fileMode);
  const fileAdmin = await raw(`http://127.0.0.1:${port3}`, "GET", "/admin/principals", { Authorization: `Bearer ${ADMIN_TOKEN}` });
  check("admin: file store -> 501", fileAdmin.status === 501, `http=${fileAdmin.status}`);
} finally {
  server.kill("SIGTERM");
  unconfigured?.kill("SIGTERM");
  fileMode?.kill("SIGTERM");
  await issuer.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "VERIFY-ADMIN: ALL PASS" : `VERIFY-ADMIN: ${failures} FAILURES`);
if (failures > 0 && serverLog) console.log("--- server log ---\n" + serverLog.slice(-3000));
process.exit(failures === 0 ? 0 : 1);
