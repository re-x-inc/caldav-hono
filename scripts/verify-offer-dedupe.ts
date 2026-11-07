// Offer replay without duplicates (next-stage order Part D):
//  - the offer-flow sequence (organizer master PUT -> scheduling delivery,
//    then the legacy operator direct PUT into the driver's default)
//    leaves exactly ONE resource with the offer UID in drv-001/default,
//    in either order
//  - the driver's ACCEPTED on that single resource reaches the master;
//    Q1 (occurrence overlap SQL) returns one row for the slot
//  - a second resource with an existing UID by anyone else -> 403
//    CALDAV:no-uid-conflict
//  - inbox policy: REQUEST superseded on re-delivery, removed once
//    answered, CANCEL replaces REQUEST, retention sweep, inbox hidden
//    from the home listing and not a CALDAV:calendar
// Self-contained: temp SQLite data area, spawned server on an ephemeral
// port with a 1-day retention. Rerunnable.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyFileName } from "../src/scheduling.js";

const OPS = "ops-001";
const EMP = "emp-001";
const DRV = "drv-001";

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

const tmp = mkdtempSync(join(tmpdir(), "caldav-dedupe-"));
const dataDir = join(tmp, "data");
const accountsPath = join(tmp, "accounts.json");
writeFileSync(accountsPath, JSON.stringify({
  accounts: [
    { username: OPS, password: "pw-ops", email: `${OPS}@example.test`, displayName: "Operator" },
    { username: EMP, password: "pw-emp", email: `${EMP}@example.test`, displayName: "Employee" },
    { username: DRV, password: "pw-drv", email: `${DRV}@example.test`, displayName: "Driver" },
  ],
}, null, 2) + "\n", { mode: 0o600 });

const env = {
  ...process.env,
  CALDAV_DATA: dataDir, CALDAV_ACCOUNTS: accountsPath, CALDAV_STORE: "sqlite",
  CALDAV_INBOX_RETENTION_DAYS: "1",
};
const seeded = spawnSync(process.execPath, ["dist/scripts/seed.js"], { env, encoding: "utf8" });
if (seeded.status !== 0) {
  console.error(seeded.stdout, seeded.stderr);
  throw new Error("seed failed");
}

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const server: ChildProcess = spawn(process.execPath, ["dist/src/index.js"], {
  env: { ...env, PORT: String(port), HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout?.on("data", (d) => { serverLog += String(d); });
server.stderr?.on("data", (d) => { serverLog += String(d); });

async function waitHealth(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (server.exitCode !== null) throw new Error(`server exited early (${server.exitCode}): ${serverLog}`);
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not become healthy");
}

const PW: Record<string, string> = { [OPS]: "pw-ops", [EMP]: "pw-emp", [DRV]: "pw-drv" };
async function dav(user: string, method: string, path: string, opts: { body?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: "Basic " + Buffer.from(`${user}:${PW[user]}`).toString("base64"),
      ...(opts.body ? { "Content-Type": method === "PUT" ? "text/calendar; charset=utf-8" : "application/xml; charset=utf-8" } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.body,
    redirect: "manual",
  });
  return { status: res.status, body: await res.text(), etag: res.headers.get("etag") };
}

function partstatOf(icsText: string, email: string): string | null {
  for (const line of icsText.split(/\r?\n/)) {
    if (line.includes(`mailto:${email}`) && line.toUpperCase().startsWith("ATTENDEE")) {
      const m = /PARTSTAT=([^;:]+)/i.exec(line);
      return m ? m[1] : "NEEDS-ACTION";
    }
  }
  return null;
}

function offerIcs(uid: string, summary: string, partstat = "NEEDS-ACTION", stamp = "20261107T000000Z"): string {
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//caldav-hono//verify-dedupe//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    "DTSTART:20261108T110000Z", "DTEND:20261108T120000Z",
    `SUMMARY:${summary}`,
    `ATTENDEE;CN=Driver;PARTSTAT=${partstat}:mailto:${DRV}@example.test`,
    `ORGANIZER;CN=Operator:mailto:${OPS}@example.test`,
    "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
}

const ALLPROP = '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>';
function queryAll(): string {
  return (
    '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
    "<D:prop><D:getetag/><C:calendar-data/></D:prop>" +
    '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/>' +
    "</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>"
  );
}
const count = (xml: string, needle: string) => xml.split(needle).length - 1;
async function uidCount(user: string, calPath: string, uid: string): Promise<number> {
  const r = await dav(user, "REPORT", calPath, { body: queryAll() });
  return count(r.body, `UID:${uid}`);
}
async function inboxMethods(user: string): Promise<string[]> {
  const r = await dav(user, "REPORT", `/calendars/${user}/inbox/`, { body: queryAll() });
  return [...r.body.matchAll(/METHOD:([A-Z]+)/g)].map((m) => m[1]);
}

const run = Date.now().toString(36);
const uid = `dedupe-offer-${run}@caldav-hono`;
const file = `dedupe-offer-${run}.ics`;
const drvDefault = `/calendars/${DRV}/default/`;
const drvDirect = `${drvDefault}${file}`;
const stageReq = `/calendars/${OPS}/stage-request/${file}`;

try {
  await waitHealth();
  check("healthz (spawned sqlite server)", true, BASE);

  // --- offer-flow order: master PUT (delivery) then operator direct PUT -----
  const put1 = await dav(OPS, "PUT", stageReq, { body: offerIcs(uid, "オファー再演：横浜駅→自宅") });
  const copyAfterMaster = await dav(DRV, "GET", `${drvDefault}${copyFileName(uid)}`);
  check("master PUT delivers one copy to drv-001/default", put1.status === 201 && copyAfterMaster.status === 200, `put=${put1.status} copy=${copyAfterMaster.status}`);
  const put2 = await dav(OPS, "PUT", drvDirect, { body: offerIcs(uid, "オファー再演：横浜駅→自宅") });
  const n1 = await uidCount(DRV, drvDefault, uid);
  const copyGone = await dav(DRV, "GET", `${drvDefault}${copyFileName(uid)}`);
  check("operator direct PUT folds onto the delivered copy: 201, UID appears once, copy file gone",
    put2.status === 201 && n1 === 1 && copyGone.status === 404, `put=${put2.status} count=${n1} copy=${copyGone.status}`);
  const inbox1 = await inboxMethods(DRV);
  check("drv-001 inbox holds exactly one REQUEST", inbox1.filter((m) => m === "REQUEST").length === 1, inbox1.join(","));

  // --- re-delivery supersedes: master updated again -> still one copy/one REQUEST
  const put3 = await dav(OPS, "PUT", stageReq, { body: offerIcs(uid, "オファー再演：横浜駅→自宅（更新）") });
  const n2 = await uidCount(DRV, drvDefault, uid);
  const direct2 = await dav(DRV, "GET", drvDirect);
  const inbox2 = await inboxMethods(DRV);
  check("master update: copy updated in place under the direct file name, still one",
    put3.status === 204 && n2 === 1 && direct2.status === 200 && direct2.body.includes("（更新）"), `put=${put3.status} count=${n2} direct=${direct2.status}`);
  check("re-delivery supersedes the earlier REQUEST (one REQUEST in inbox)", inbox2.filter((m) => m === "REQUEST").length === 1, inbox2.join(","));

  // --- driver accepts on the single resource -> master ACCEPTED, REQUEST cleared
  const accept = await dav(DRV, "PUT", drvDirect, {
    body: direct2.body.replace("PARTSTAT=NEEDS-ACTION", "PARTSTAT=ACCEPTED"),
    headers: { "If-Match": direct2.etag ?? "" },
  });
  const master = await dav(OPS, "GET", stageReq);
  const n3 = await uidCount(DRV, drvDefault, uid);
  check("driver ACCEPTED on the single resource -> master ACCEPTED, still one resource",
    accept.status === 204 && partstatOf(master.body, `${DRV}@example.test`) === "ACCEPTED" && n3 === 1,
    `accept=${accept.status} master=${partstatOf(master.body, `${DRV}@example.test`)} count=${n3}`);
  const inbox3 = await inboxMethods(DRV);
  check("answered REQUEST removed from drv-001 inbox", !inbox3.includes("REQUEST"), inbox3.join(",") || "empty");
  const opsInbox = await inboxMethods(OPS);
  check("ops-001 inbox holds the REPLY", opsInbox.includes("REPLY"), opsInbox.join(","));

  // --- Q1 on the live DB: one occurrence row for the slot ------------------------
  const db = new DatabaseSync(join(dataDir, "caldav.sqlite"), { readOnly: true });
  const H = 3_600_000;
  const q1 = db.prepare(
    "SELECT COUNT(*) AS n FROM occurrences WHERE owner=? AND cal_id='default' AND uid=? " +
    "AND cancelled=0 AND transparent=0 AND dtstart_ms < ? AND dtend_ms > ?",
  ).get(DRV, uid, Date.UTC(2026, 10, 8, 12) + H, Date.UTC(2026, 10, 8, 11) - H) as unknown as { n: number };
  db.close();
  check("Q1 overlap lists the offer once (no duplicate rows)", q1.n === 1, `rows=${q1.n}`);

  // --- reverse order: direct PUT first, then master PUT ----------------------------
  const uidB = `dedupe-rev-${run}@caldav-hono`;
  const fileB = `dedupe-rev-${run}.ics`;
  const putB1 = await dav(OPS, "PUT", `${drvDefault}${fileB}`, { body: offerIcs(uidB, "逆順オファー") });
  const putB2 = await dav(OPS, "PUT", `/calendars/${OPS}/stage-request/${fileB}`, { body: offerIcs(uidB, "逆順オファー") });
  const nB = await uidCount(DRV, drvDefault, uidB);
  const copyB = await dav(DRV, "GET", `${drvDefault}${copyFileName(uidB)}`);
  check("reverse order (direct PUT, then master PUT): delivery updates the existing resource, UID once, no copy file",
    putB1.status === 201 && putB2.status === 201 && nB === 1 && copyB.status === 404, `direct=${putB1.status} master=${putB2.status} count=${nB} copy=${copyB.status}`);

  // --- no-uid-conflict for anyone else ----------------------------------------------
  const conflict = await dav(DRV, "PUT", `${drvDefault}another-name-${run}.ics`, { body: offerIcs(uid, "同じ UID 別ファイル") });
  check("second resource with an existing UID by the owner -> 403 no-uid-conflict",
    conflict.status === 403 && conflict.body.includes("no-uid-conflict"), `http=${conflict.status}`);

  // --- cancel replaces REQUEST; copies removed ----------------------------------------
  const cancel = await dav(OPS, "DELETE", `/calendars/${OPS}/stage-request/${fileB}`);
  const nB2 = await uidCount(DRV, drvDefault, uidB);
  const inboxB = await dav(DRV, "REPORT", `/calendars/${DRV}/inbox/`, { body: queryAll() });
  const msgsB = inboxB.body.split("BEGIN:VCALENDAR").filter((s) => s.includes(`UID:${uidB}`));
  check("organizer DELETE: copy removed, inbox keeps one CANCEL for the UID (REQUEST superseded)",
    cancel.status === 204 && nB2 === 0 && msgsB.length === 1 && msgsB[0].includes("METHOD:CANCEL"),
    `del=${cancel.status} count=${nB2} msgs=${msgsB.length}`);

  // --- retention sweep (1 day): an old message disappears on the next delivery -----
  const oldUid = `dedupe-old-${run}@caldav-hono`;
  const oldMsg = offerIcs(oldUid, "古いメッセージ", "NEEDS-ACTION", "20260101T000000Z").replace("BEGIN:VEVENT", "METHOD:REQUEST\r\nBEGIN:VEVENT");
  const putOld = await dav(DRV, "PUT", `/calendars/${DRV}/inbox/old-${run}.ics`, { body: oldMsg });
  const uidC = `dedupe-fresh-${run}@caldav-hono`;
  await dav(OPS, "PUT", `/calendars/${OPS}/stage-request/dedupe-fresh-${run}.ics`, { body: offerIcs(uidC, "新しいオファー") });
  const oldGone = await dav(DRV, "GET", `/calendars/${DRV}/inbox/old-${run}.ics`);
  check("retention: message older than CALDAV_INBOX_RETENTION_DAYS swept on next delivery",
    putOld.status === 201 && oldGone.status === 404, `put=${putOld.status} get=${oldGone.status}`);

  // --- inbox visibility --------------------------------------------------------------------
  const home = await dav(DRV, "PROPFIND", `/calendars/${DRV}/`, { headers: { Depth: "1" }, body: ALLPROP });
  check("home listing does not include the inbox", home.status === 207 && !home.body.includes(`/calendars/${DRV}/inbox/`), `http=${home.status}`);
  const inboxProps = await dav(DRV, "PROPFIND", `/calendars/${DRV}/inbox/`, { body: ALLPROP });
  const rt = /<D:resourcetype>(.*?)<\/D:resourcetype>/.exec(inboxProps.body)?.[1] ?? "";
  check("inbox resourcetype is schedule-inbox, not a calendar", inboxProps.status === 207 && rt.includes("schedule-inbox") && !rt.includes("<C:calendar/>"), rt);
  const principal = await dav(DRV, "PROPFIND", `/principals/${DRV}/`, { body: ALLPROP });
  check("principal advertises schedule-inbox-URL", principal.body.includes("schedule-inbox-URL") && principal.body.includes(`/calendars/${DRV}/inbox/`));

  // cleanup of the organizer masters (copies follow via CANCEL)
  await dav(OPS, "DELETE", stageReq);
  await dav(OPS, "DELETE", `/calendars/${OPS}/stage-request/dedupe-fresh-${run}.ics`);
} finally {
  server.kill("SIGTERM");
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "VERIFY-OFFER-DEDUPE: ALL PASS" : `VERIFY-OFFER-DEDUPE: ${failures} FAILURES`);
if (failures > 0 && serverLog) console.log("--- server log ---\n" + serverLog.slice(-3000));
process.exit(failures === 0 ? 0 : 1);
