// Storage boundary: HTTP handlers only ever call this module. Two
// backends sit behind it, selected by CALDAV_STORE:
//   file   - one file per event under the data dir (original layout:
//            data/calendars/<owner>/<calId>/{meta.json,events/*.ics,
//            journal.jsonl})
//   sqlite - store-sqlite.ts (design memo section 7 shape); the default
// CTag and sync-token both derive from the per-calendar sequence number.

import { createHash } from "node:crypto";
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync,
  renameSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { attendeesOf, firstUid, normAddr, setAttendeePartstat } from "./ical.js";
import * as sqlite from "./store-sqlite.js";

// SQLite is the default; CALDAV_STORE=file switches back to the file layout.
export function storeBackend(): "file" | "sqlite" {
  return (process.env.CALDAV_STORE ?? "sqlite").trim().toLowerCase() === "file"
    ? "file"
    : "sqlite";
}

const useSqlite = () => storeBackend() === "sqlite";

export interface CalendarMeta {
  id: string;
  owner: string;
  displayname: string;
  color: string | null;
  readers: string[]; // usernames with read-only access (besides owner)
  writers: string[]; // usernames with write access (besides owner)
  seq: number;
}

export interface JournalEntry {
  seq: number;
  file: string;
  etag: string;
  deleted: boolean;
}

export function dataDir(): string {
  return process.env.CALDAV_DATA ?? join(process.cwd(), "data");
}

function calDir(owner: string, calId: string): string {
  return join(dataDir(), "calendars", owner, calId);
}

export function etagOf(content: string): string {
  return `"${createHash("sha256").update(content, "utf8").digest("hex").slice(0, 32)}"`;
}

function fileGetCalendar(owner: string, calId: string): CalendarMeta | null {
  const p = join(calDir(owner, calId), "meta.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as CalendarMeta;
}

function saveMeta(meta: CalendarMeta): void {
  writeFileSync(join(calDir(meta.owner, meta.id), "meta.json"), JSON.stringify(meta, null, 2) + "\n");
}

function fileCreateCalendar(meta: Omit<CalendarMeta, "seq">): CalendarMeta {
  const full: CalendarMeta = { ...meta, seq: 0 };
  mkdirSync(join(calDir(meta.owner, meta.id), "events"), { recursive: true });
  saveMeta(full);
  return full;
}

function fileUpdateCalendar(meta: CalendarMeta): void {
  saveMeta(meta);
}

function fileDeleteCalendar(owner: string, calId: string): boolean {
  if (!existsSync(calDir(owner, calId))) return false;
  rmSync(calDir(owner, calId), { recursive: true, force: true });
  return true;
}

function fileListCalendars(owner: string): CalendarMeta[] {
  const base = join(dataDir(), "calendars", owner);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => fileGetCalendar(owner, d.name))
    .filter((m): m is CalendarMeta => m !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}

// Calendars owned by others that this user may read or write.
function fileSharedCalendars(username: string): CalendarMeta[] {
  const base = join(dataDir(), "calendars");
  if (!existsSync(base)) return [];
  const out: CalendarMeta[] = [];
  for (const ownerEnt of readdirSync(base, { withFileTypes: true })) {
    if (!ownerEnt.isDirectory() || ownerEnt.name === username) continue;
    for (const meta of fileListCalendars(ownerEnt.name)) {
      if (meta.readers.includes(username) || meta.writers.includes(username)) out.push(meta);
    }
  }
  return out.sort((a, b) => `${a.owner}/${a.id}`.localeCompare(`${b.owner}/${b.id}`));
}

function bumpSeq(meta: CalendarMeta, entry: Omit<JournalEntry, "seq">): void {
  meta.seq += 1;
  appendFileSync(
    join(calDir(meta.owner, meta.id), "journal.jsonl"),
    JSON.stringify({ seq: meta.seq, ...entry }) + "\n",
  );
  saveMeta(meta);
}

export interface StoredEvent {
  file: string;
  content: string;
  etag: string;
}

function fileGetEvent(meta: CalendarMeta, file: string): StoredEvent | null {
  const p = join(calDir(meta.owner, meta.id), "events", file);
  if (!existsSync(p)) return null;
  const content = readFileSync(p, "utf8");
  return { file, content, etag: etagOf(content) };
}

function fileListEvents(meta: CalendarMeta): StoredEvent[] {
  const dir = join(calDir(meta.owner, meta.id), "events");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ics"))
    .sort()
    .map((f) => fileGetEvent(meta, f))
    .filter((e): e is StoredEvent => e !== null);
}

function filePutEvent(meta: CalendarMeta, file: string, content: string): StoredEvent {
  const dir = join(calDir(meta.owner, meta.id), "events");
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${file}.tmp`);
  writeFileSync(tmp, content);
  renameSync(tmp, join(dir, file));
  const etag = etagOf(content);
  bumpSeq(meta, { file, etag, deleted: false });
  return { file, content, etag };
}

function fileDeleteEvent(meta: CalendarMeta, file: string): boolean {
  const ev = fileGetEvent(meta, file);
  if (!ev) return false;
  rmSync(join(calDir(meta.owner, meta.id), "events", file));
  bumpSeq(meta, { file, etag: ev.etag, deleted: true });
  return true;
}

function fileJournalSince(meta: CalendarMeta, sinceSeq: number): JournalEntry[] {
  const p = join(calDir(meta.owner, meta.id), "journal.jsonl");
  if (!existsSync(p)) return [];
  // Collapse to the last entry per file.
  const byFile = new Map<string, JournalEntry>();
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as JournalEntry;
    if (e.seq > sinceSeq) byFile.set(e.file, e);
  }
  return [...byFile.values()].sort((a, b) => a.seq - b.seq);
}

// --- backend dispatch (the public surface handlers use) -------------------

export function getCalendar(owner: string, calId: string): CalendarMeta | null {
  return useSqlite() ? sqlite.getCalendar(owner, calId) : fileGetCalendar(owner, calId);
}

export function createCalendar(meta: Omit<CalendarMeta, "seq">): CalendarMeta {
  return useSqlite() ? sqlite.createCalendar(meta) : fileCreateCalendar(meta);
}

export function updateCalendar(meta: CalendarMeta): void {
  if (useSqlite()) sqlite.updateCalendar(meta); else fileUpdateCalendar(meta);
}

export function deleteCalendar(owner: string, calId: string): boolean {
  return useSqlite() ? sqlite.deleteCalendar(owner, calId) : fileDeleteCalendar(owner, calId);
}

export function listCalendars(owner: string): CalendarMeta[] {
  return useSqlite() ? sqlite.listCalendars(owner) : fileListCalendars(owner);
}

export function sharedCalendars(username: string): CalendarMeta[] {
  return useSqlite() ? sqlite.sharedCalendars(username) : fileSharedCalendars(username);
}

export function getEvent(meta: CalendarMeta, file: string): StoredEvent | null {
  return useSqlite() ? sqlite.getEvent(meta, file) : fileGetEvent(meta, file);
}

export function listEvents(meta: CalendarMeta): StoredEvent[] {
  return useSqlite() ? sqlite.listEvents(meta) : fileListEvents(meta);
}

export function putEvent(meta: CalendarMeta, file: string, content: string): StoredEvent {
  return useSqlite() ? sqlite.putEvent(meta, file, content) : filePutEvent(meta, file, content);
}

export function deleteEvent(meta: CalendarMeta, file: string): boolean {
  return useSqlite() ? sqlite.deleteEvent(meta, file) : fileDeleteEvent(meta, file);
}

export function journalSince(meta: CalendarMeta, sinceSeq: number): JournalEntry[] {
  return useSqlite() ? sqlite.journalSince(meta, sinceSeq) : fileJournalSince(meta, sinceSeq);
}

// --- scheduling support ------------------------------------------------------

export interface LocatedEvent {
  meta: CalendarMeta;
  event: StoredEvent;
}

export interface ReplyResult {
  applied: boolean;
  // "not-found" | "not-attendee" | "already-accepted" when applied=false
  reason?: string;
  stored?: StoredEvent;
}

// Every resource (any owner/calendar) carrying this UID: organizer masters
// and attendee copies alike. Callers distinguish by ORGANIZER/owner.
export function findEventsByUid(uid: string): LocatedEvent[] {
  if (useSqlite()) return sqlite.findEventsByUid(uid);
  const base = join(dataDir(), "calendars");
  if (!existsSync(base)) return [];
  const out: LocatedEvent[] = [];
  for (const ownerEnt of readdirSync(base, { withFileTypes: true })) {
    if (!ownerEnt.isDirectory()) continue;
    for (const meta of fileListCalendars(ownerEnt.name)) {
      for (const event of fileListEvents(meta)) {
        if (firstUid(event.content) === uid) out.push({ meta, event });
      }
    }
  }
  return out;
}

// Server-side PARTSTAT application on a master resource. The SQLite
// backend does this as a transactional conditional update; the file
// backend performs the same check-then-write synchronously (atomic only
// within this process - one more reason the DB backend is the target).
export function applyPartstatReply(
  meta: CalendarMeta, file: string, attendeeAddress: string, partstat: string,
): ReplyResult {
  if (useSqlite()) return sqlite.applyPartstatReply(meta, file, attendeeAddress, partstat);
  const ev = fileGetEvent(meta, file);
  if (!ev) return { applied: false, reason: "not-found" };
  const addr = normAddr(attendeeAddress);
  const atts = attendeesOf(ev.content);
  const mine = atts.find((a) => a.address === addr);
  if (!mine) return { applied: false, reason: "not-attendee" };
  if (
    partstat === "ACCEPTED" && mine.partstat !== "ACCEPTED" &&
    atts.some((a) => a.address !== addr && a.partstat === "ACCEPTED")
  ) {
    return { applied: false, reason: "already-accepted" };
  }
  const stored = filePutEvent(meta, file, setAttendeePartstat(ev.content, addr, partstat));
  return { applied: true, stored };
}

// Resources in one calendar carrying a UID (RFC 4791 5.3.2.1 wants at
// most one). Used for no-uid-conflict and for server-delivered copies.
export function eventsWithUid(meta: CalendarMeta, uid: string): StoredEvent[] {
  return listEvents(meta).filter((ev) => firstUid(ev.content) === uid);
}

export function syncToken(meta: CalendarMeta): string {
  return `urn:caldav-hono:sync:${meta.owner}:${meta.id}:${meta.seq}`;
}

export function parseSyncToken(meta: CalendarMeta, token: string): number | null {
  const m = /^urn:caldav-hono:sync:([^:]+):([^:]+):(\d+)$/.exec(token.trim());
  if (!m || m[1] !== meta.owner || m[2] !== meta.id) return null;
  const seq = +m[3];
  return seq >= 0 && seq <= meta.seq ? seq : null;
}
