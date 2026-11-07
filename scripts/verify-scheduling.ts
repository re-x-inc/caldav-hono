// Scheduling verification (DB-scheduling order Part B + Part C queries):
// organizer PUT -> REQUEST delivered (copy + inbox) -> attendee edits own
// copy -> server applies REPLY to master -> second ACCEPTED loses the
// first-come race -> confirmed run PUT into a stage calendar -> attendee
// deleting own copy reads as DECLINED -> organizer DELETE propagates
// CANCEL and removes copies. Part C SQL runs against the same database.
// Self-contained: seeds a temp SQLite data area and spawns a server on an
// ephemeral port (never the shared 5232 instance). Rerunnable.

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

const tmp = mkdtempSync(join(tmpdir(), "caldav-sched-"));
const dataDir = join(tmp, "data");
const accountsPath = join(tmp, "accounts.json");
writeFileSync(accountsPath, JSON.stringify({
  accounts: [
    { username: OPS, password: "pw-ops", email: `${OPS}@example.test`, displayName: "Operator" },
    { username: EMP, password: "pw-emp", email: `${EMP}@example.test`, displayName: "Employee" },
    { username: DRV, password: "pw-drv", email: `${DRV}@example.test`, displayName: "Driver" },
  ],
}, null, 2) + "\n", { mode: 0o600 });

const seedEnv = {
  ...process.env,
  CALDAV_DATA: dataDir, CALDAV_ACCOUNTS: accountsPath, CALDAV_STORE: "sqlite",
};
const seeded = spawnSync(process.execPath, ["dist/scripts/seed.js"], { env: seedEnv, encoding: "utf8" });
if (seeded.status !== 0) {
  console.error(seeded.stdout, seeded.stderr);
  throw new Error("seed failed");
}

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const server: ChildProcess = spawn(process.execPath, ["dist/src/index.js"], {
  env: { ...seedEnv, PORT: String(port), HOST: "127.0.0.1" },
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

const run = Date.now().toString(36);
const uid1 = `sched-ev1-${run}@caldav-hono`;
const masterPath = `/calendars/${OPS}/stage-request/sched-ev1-${run}.ics`;
const drvCopyPath = `/calendars/${DRV}/default/${copyFileName(uid1)}`;
const empCopyPath = `/calendars/${EMP}/default/${copyFileName(uid1)}`;

function offerIcs(uid: string, attendees: string[], extra: string[] = []): string {
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//caldav-hono//verify-scheduling//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20261107T000000Z",
    "DTSTART:20261110T110000Z", "DTEND:20261110T120000Z",
    "SUMMARY:スケジューリング検証：横浜駅→自宅",
    `ORGANIZER;CN=Operator:mailto:${OPS}@example.test`,
    ...attendees.map((a) => `ATTENDEE;CN=${a};PARTSTAT=NEEDS-ACTION:mailto:${a}@example.test`),
    ...extra,
    "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
}

function calendarQueryAll(): string {
  return (
    '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
    "<D:prop><D:getetag/><C:calendar-data/></D:prop>" +
    '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/>' +
    "</C:comp-filter></C:filter></C:calendar-query>"
  );
}

try {
  await waitHealth();
  check("healthz (spawned sqlite server)", true, BASE);

  // 1. Organizer invites two candidate drivers; response deadline set.
  const put = await dav(OPS, "PUT", masterPath, {
    body: offerIcs(uid1, [DRV, EMP], ["X-RESPONSE-DUE:20261107T120000Z"]),
  });
  check("organizer PUT master with ATTENDEEs 201", put.status === 201, `http=${put.status}`);

  const drvCopy = await dav(DRV, "GET", drvCopyPath);
  check("REQUEST delivered: drv-001 default has copy NEEDS-ACTION",
    drvCopy.status === 200 && partstatOf(drvCopy.body, `${DRV}@example.test`) === "NEEDS-ACTION",
    `http=${drvCopy.status}`);

  const empCopy = await dav(EMP, "GET", empCopyPath);
  check("REQUEST delivered: emp-001 default has copy", empCopy.status === 200, `http=${empCopy.status}`);

  const drvInbox = await dav(DRV, "REPORT", `/calendars/${DRV}/inbox/`, { body: calendarQueryAll() });
  check("drv-001 inbox holds METHOD:REQUEST", drvInbox.status === 207 && drvInbox.body.includes("METHOD:REQUEST"), `http=${drvInbox.status}`);

  // 2. drv-001 accepts by editing ONLY their own copy.
  const accept = await dav(DRV, "PUT", drvCopyPath, {
    body: drvCopy.body.replace("PARTSTAT=NEEDS-ACTION", "PARTSTAT=ACCEPTED"),
    headers: { "If-Match": drvCopy.etag ?? "" },
  });
  check("drv-001 ACCEPTED on own copy 204", accept.status === 204, `http=${accept.status}`);

  const master1 = await dav(OPS, "GET", masterPath);
  check("server applied REPLY to master: drv-001 ACCEPTED",
    partstatOf(master1.body, `${DRV}@example.test`) === "ACCEPTED",
    `drv=${partstatOf(master1.body, `${DRV}@example.test`)}`);
  check("master: emp-001 still NEEDS-ACTION",
    partstatOf(master1.body, `${EMP}@example.test`) === "NEEDS-ACTION");

  const opsInbox = await dav(OPS, "REPORT", `/calendars/${OPS}/inbox/`, { body: calendarQueryAll() });
  check("ops-001 inbox holds METHOD:REPLY", opsInbox.body.includes("METHOD:REPLY"));

  // 3. First-come race: emp-001's late ACCEPTED must not overwrite.
  const empNow = await dav(EMP, "GET", empCopyPath);
  await dav(EMP, "PUT", empCopyPath, {
    body: empNow.body.replace("PARTSTAT=NEEDS-ACTION", "PARTSTAT=ACCEPTED"), // only emp-001's line is still NEEDS-ACTION
    headers: { "If-Match": empNow.etag ?? "" },
  });
  const master2 = await dav(OPS, "GET", masterPath);
  check("first-come: master keeps drv-001 ACCEPTED after emp-001 late ACCEPTED",
    partstatOf(master2.body, `${DRV}@example.test`) === "ACCEPTED" &&
    partstatOf(master2.body, `${EMP}@example.test`) === "NEEDS-ACTION",
    `drv=${partstatOf(master2.body, `${DRV}@example.test`)} emp=${partstatOf(master2.body, `${EMP}@example.test`)}`);

  // 4. Part C SQL against the live database file.
  const db = new DatabaseSync(join(dataDir, "caldav.sqlite"), { readOnly: true });
  const startMs = Date.UTC(2026, 10, 10, 11), endMs = Date.UTC(2026, 10, 10, 12), H = 3_600_000;
  const overlapSql =
    "SELECT COUNT(*) AS n FROM occurrences WHERE owner=? AND cal_id='default' " +
    "AND cancelled=0 AND transparent=0 AND dtstart_ms < ? AND dtend_ms > ?";
  const busy = (db.prepare(overlapSql).get(DRV, endMs + H, startMs - H) as unknown as { n: number }).n;
  check("Q1 overlap: drv-001 busy at offered slot (+/-1h)", busy >= 1, `rows=${busy}`);
  const free = (db.prepare(overlapSql).get(DRV, Date.UTC(2026, 11, 25, 12) + H, Date.UTC(2026, 11, 25, 11) - H) as unknown as { n: number }).n;
  check("Q1 overlap: drv-001 free on 2026-12-25 11:00Z", free === 0, `rows=${free}`);
  const due = db.prepare(
    "SELECT a.attendee FROM event_attendees a JOIN events e ON e.href=a.href " +
    "WHERE a.partstat='NEEDS-ACTION' AND a.response_due IS NOT NULL AND a.response_due <= ? " +
    "AND EXISTS (SELECT 1 FROM principals p WHERE 'mailto:' || lower(p.email) = e.organizer AND p.username = e.owner) " +
    "ORDER BY a.response_due",
  ).all("2026-11-09T00:00:00.000Z") as unknown as { attendee: string }[];
  check("Q2 unanswered: overdue/near NEEDS-ACTION lists emp-001 (not accepted drv-001)",
    due.some((r) => r.attendee.includes(EMP)) && !due.some((r) => r.attendee.includes(DRV)),
    due.map((r) => r.attendee).join(","));
  db.close();

  // 5. Confirmed run recorded into a stage calendar by ordinary PUT.
  const bookedPath = `/calendars/${OPS}/stage-booked/sched-confirmed-${run}.ics`;
  const booked = await dav(OPS, "PUT", bookedPath, {
    body: offerIcs(`sched-confirmed-${run}@caldav-hono`, [DRV]),
  });
  const bookedGet = await dav(OPS, "GET", bookedPath);
  check("stage record: PUT confirmed run to stage-booked + GET",
    booked.status === 201 && bookedGet.status === 200, `put=${booked.status} get=${bookedGet.status}`);
  await dav(OPS, "DELETE", bookedPath);

  // 6. Attendee deleting their own copy reads as DECLINED on the master.
  const uid2 = `sched-ev2-${run}@caldav-hono`;
  const master2Path = `/calendars/${OPS}/stage-request/sched-ev2-${run}.ics`;
  await dav(OPS, "PUT", master2Path, { body: offerIcs(uid2, [EMP]) });
  const delCopy = await dav(EMP, "DELETE", `/calendars/${EMP}/default/${copyFileName(uid2)}`);
  const master3 = await dav(OPS, "GET", master2Path);
  check("attendee copy DELETE -> master DECLINED",
    delCopy.status === 204 && partstatOf(master3.body, `${EMP}@example.test`) === "DECLINED",
    `del=${delCopy.status} emp=${partstatOf(master3.body, `${EMP}@example.test`)}`);
  await dav(OPS, "DELETE", master2Path);

  // 7. Organizer cancellation propagates: copies gone, CANCEL in inbox.
  const cancel = await dav(OPS, "DELETE", masterPath);
  const drvGone = await dav(DRV, "GET", drvCopyPath);
  const drvInbox2 = await dav(DRV, "REPORT", `/calendars/${DRV}/inbox/`, { body: calendarQueryAll() });
  check("organizer DELETE 204", cancel.status === 204, `http=${cancel.status}`);
  check("CANCEL propagation: drv-001 copy removed", drvGone.status === 404, `http=${drvGone.status}`);
  check("drv-001 inbox holds METHOD:CANCEL", drvInbox2.body.includes("METHOD:CANCEL"));
} finally {
  server.kill("SIGTERM");
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "VERIFY-SCHEDULING: ALL PASS" : `VERIFY-SCHEDULING: ${failures} FAILURES`);
if (failures > 0 && serverLog) console.log("--- server log ---\n" + serverLog.slice(-3000));
process.exit(failures === 0 ? 0 : 1);
