// Seed: accounts + the built-in starter calendar set.
// - Accounts are stable IDs (identity); displayName keeps the person's
//   name for presentation only:
//     ops-001 (business, Operator), emp-001 (employee, Employee), drv-001 (contractor, Driver).
// - ops-001 owns the three stage calendars (read-only for emp-001/drv-001).
// - drv-001 has a "受けられる時間" calendar; ops-001 may write into drv-001's
//   default calendar (legacy operator direct-write offer path).
// Passwords are generated here and stored only in
// config/accounts.local.json (gitignored, mode 0600). Re-running keeps
// existing passwords, creates what is missing, and reconciles calendar
// metadata (owner/displayname/color/readers/writers) with the shape below.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { accountsPath } from "../src/auth.js";
import {
  createCalendar, getCalendar, getEvent, putEvent, updateCalendar,
  type CalendarMeta,
} from "../src/store.js";

const USERS = [
  { username: "ops-001", displayName: "Operator" },
  { username: "emp-001", displayName: "Employee" },
  { username: "drv-001", displayName: "Driver" },
] as const;

const OPS = "ops-001";
const EMP = "emp-001";
const DRV = "drv-001";

function ensureAccounts(): void {
  const p = accountsPath();
  if (existsSync(p)) {
    console.log(`accounts file exists, keeping passwords: ${p}`);
    return;
  }
  const accounts = USERS.map(({ username, displayName }) => ({
    username,
    password: randomBytes(9).toString("base64url"),
    email: `${username}@example.test`,
    displayName,
  }));
  writeFileSync(p, JSON.stringify({ accounts }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
  console.log(`accounts file created (0600): ${p}`);
}

function ensureCalendar(meta: Omit<CalendarMeta, "seq">): CalendarMeta {
  const existing = getCalendar(meta.owner, meta.id);
  if (!existing) {
    console.log(`calendar created: ${meta.owner}/${meta.id} (${meta.displayname})`);
    return createCalendar(meta);
  }
  const changed =
    existing.owner !== meta.owner ||
    existing.displayname !== meta.displayname ||
    existing.color !== meta.color ||
    existing.readers.join(",") !== meta.readers.join(",") ||
    existing.writers.join(",") !== meta.writers.join(",");
  if (changed) {
    const updated: CalendarMeta = { ...meta, seq: existing.seq };
    updateCalendar(updated);
    console.log(`calendar updated: ${meta.owner}/${meta.id} (${meta.displayname})`);
    return updated;
  }
  return existing;
}

ensureAccounts();

for (const u of USERS) {
  ensureCalendar({
    id: "default", owner: u.username, displayname: u.displayName, color: null,
    readers: [], writers: u.username === DRV ? [OPS] : [],
  });
}

const stageReaders = [EMP, DRV];
ensureCalendar({ id: "stage-request", owner: OPS, displayname: "予約依頼", color: "#e8710a", readers: stageReaders, writers: [] });
ensureCalendar({ id: "stage-booked", owner: OPS, displayname: "予約済み", color: "#0b8043", readers: stageReaders, writers: [] });
ensureCalendar({ id: "stage-dispatched", owner: OPS, displayname: "配車手配済み", color: "#3f51b5", readers: stageReaders, writers: [] });
ensureCalendar({ id: "avail", owner: DRV, displayname: "受けられる時間", color: "#f9ab00", readers: [OPS], writers: [] });

// drv-001 availability block covering 2026-11-08 20:00-21:00 JST (offer flow replay).
const avail = getCalendar(DRV, "avail");
if (avail && !getEvent(avail, "seed-avail-20261108.ics")) {
  putEvent(avail, "seed-avail-20261108.ics", [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//caldav-hono//seed//EN",
    "BEGIN:VEVENT",
    "UID:seed-avail-20261108@caldav-hono",
    "DTSTAMP:20261106T000000Z",
    "DTSTART:20261108T090000Z",
    "DTEND:20261108T130000Z",
    "SUMMARY:受けられる時間（seed）",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n"));
  console.log("seed availability event put: drv-001/avail/seed-avail-20261108.ics (18:00-22:00 JST)");
}

const parsed = JSON.parse(readFileSync(accountsPath(), "utf8")) as { accounts: { username: string }[] };
console.log(`seed done. accounts: ${parsed.accounts.map((a) => a.username).join(", ")}`);
console.log("passwords: see config/accounts.local.json (not printed)");
