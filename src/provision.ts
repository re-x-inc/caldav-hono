// Principal kinds, ID allocation and the initial calendar set the admin
// plane gives a new principal. Mirrors the seed layout (scripts/seed.ts):
//   ops-xxx  business: default + stage-request/booked/dispatched
//            (read-only for every emp/drv) + inbox
//   emp-xxx  employee: default + inbox, reads every ops stage calendar
//   drv-xxx  contractor/driver: default + avail (read by every ops) +
//            inbox, reads every ops stage calendar
// Operators are NOT made writers of a driver's default calendar: offers
// reach attendees through scheduling delivery, not direct writes.

import { mailDomain } from "./accounts-file.js";
import { loadAccounts, type Account } from "./auth.js";
import { ensureInbox } from "./scheduling.js";
import {
  createCalendar, getCalendar, listCalendars, updateCalendar, type CalendarMeta,
} from "./store.js";

export type PrincipalKind = "ops" | "emp" | "drv";
export const KINDS: PrincipalKind[] = ["ops", "emp", "drv"];

export const USERNAME_RE = /^(ops|emp|drv)-(\d{3,})$/;

export function kindOf(username: string): PrincipalKind | null {
  const m = USERNAME_RE.exec(username);
  return m ? (m[1] as PrincipalKind) : null;
}

// Next free number for a kind, never below one already seen anywhere.
export function allocateUsername(kind: PrincipalKind, taken: string[]): string {
  let max = 0;
  for (const u of taken) {
    const m = USERNAME_RE.exec(u);
    if (m && m[1] === kind) max = Math.max(max, +m[2]);
  }
  return `${kind}-${String(max + 1).padStart(3, "0")}`;
}

export function defaultEmail(username: string): string {
  return `${username}@${mailDomain()}`;
}

export const STAGE_CALENDARS: { id: string; displayname: string; color: string }[] = [
  { id: "stage-request", displayname: "予約依頼", color: "#e8710a" },
  { id: "stage-booked", displayname: "予約済み", color: "#0b8043" },
  { id: "stage-dispatched", displayname: "配車手配済み", color: "#3f51b5" },
];

export const AVAIL_CALENDAR = { id: "avail", displayname: "受けられる時間", color: "#f9ab00" };

function ensureCalendar(meta: Omit<CalendarMeta, "seq">): CalendarMeta {
  return getCalendar(meta.owner, meta.id) ?? createCalendar(meta);
}

function addReader(meta: CalendarMeta, username: string): void {
  if (meta.readers.includes(username) || meta.writers.includes(username)) return;
  meta.readers = [...meta.readers, username].sort();
  updateCalendar(meta);
}

export function activeUsernames(kind?: PrincipalKind): string[] {
  return loadAccounts()
    .filter((a) => a.status !== "disabled" && (!kind || kindOf(a.username) === kind))
    .map((a) => a.username);
}

export interface ProvisionResult {
  owned: string[]; // calendar ids created or confirmed for the principal
  granted: string[]; // "<owner>/<cal>" the principal now reads
}

// Idempotent: creates what is missing, adds missing grants, never
// removes anything.
export function provisionPrincipal(account: Account): ProvisionResult {
  const kind = kindOf(account.username);
  if (!kind) throw new Error(`username has no kind: ${account.username}`);
  const me = account.username;
  const owned: string[] = [];
  const granted: string[] = [];

  ensureCalendar({
    id: "default", owner: me, displayname: account.displayName ?? me, color: null,
    readers: [], writers: [],
  });
  owned.push("default");
  ensureInbox(me);
  owned.push("inbox");

  const allOps = activeUsernames("ops").filter((u) => u !== me);
  const allStaff = [...activeUsernames("emp"), ...activeUsernames("drv")].filter((u) => u !== me);

  if (kind === "ops") {
    for (const s of STAGE_CALENDARS) {
      const meta = ensureCalendar({ id: s.id, owner: me, displayname: s.displayname, color: s.color, readers: [], writers: [] });
      for (const u of allStaff) addReader(meta, u);
      owned.push(s.id);
    }
    // Read every driver's availability.
    for (const drv of activeUsernames("drv")) {
      const avail = getCalendar(drv, AVAIL_CALENDAR.id);
      if (avail) { addReader(avail, me); granted.push(`${drv}/${avail.id}`); }
    }
  } else {
    if (kind === "drv") {
      const avail = ensureCalendar({ id: AVAIL_CALENDAR.id, owner: me, displayname: AVAIL_CALENDAR.displayname, color: AVAIL_CALENDAR.color, readers: [], writers: [] });
      for (const u of allOps) addReader(avail, u);
      owned.push(avail.id);
    }
    for (const ops of allOps) {
      for (const meta of listCalendars(ops)) {
        if (!STAGE_CALENDARS.some((s) => s.id === meta.id)) continue;
        addReader(meta, me);
        granted.push(`${ops}/${meta.id}`);
      }
    }
  }
  return { owned, granted };
}
