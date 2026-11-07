// SQLite-backed store (design memo section 7 shape), via Node's built-in
// node:sqlite (Node is MIT-licensed; SQLite itself is public domain).
// Same function surface as the file store in store.ts; handlers never see
// SQL. One transaction per mutation: event row + attendee index +
// occurrence projection + journal entry + seq bump commit together, which
// is what makes ETag/sync-token updates atomic.
//
// Tables:
//   principals(username, email, displayname)
//   calendars(owner, id, displayname, color, seq)
//   calendar_acl(owner, cal_id, username, access)  -- 'read' | 'write'
//   events(href PK, owner, cal_id, file, uid, dtstart, dtend, rrule,
//          summary, etag, content)                -- content is the source
//   event_attendees(href, attendee, partstat, response_due)
//   journal(owner, cal_id, seq, file, etag, deleted) -- sync-token log
//   occurrences(href, owner, cal_id, uid, recurrence_id, dtstart_ms,
//               dtend_ms, transparent, cancelled)    -- derived projection

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readAccountsFile } from "./accounts-file.js";
import type { Account, PrincipalStatus } from "./auth.js";
import {
  attendeesOf, masterEvent, normAddr, propOf, setAttendeePartstat,
} from "./ical.js";
import { hashPassword, verifyPassword } from "./password.js";
import { expandCalendar } from "./recurrence.js";
import type {
  CalendarMeta, JournalEntry, LocatedEvent, ReplyResult, StoredEvent,
} from "./store.js";

function dataDirLocal(): string {
  return process.env.CALDAV_DATA ?? join(process.cwd(), "data");
}

export function sqlitePath(): string {
  return process.env.CALDAV_DB ?? join(dataDirLocal(), "caldav.sqlite");
}

// Must produce exactly store.ts etagOf() values (same hash, same quoting).
function etagOf(content: string): string {
  return `"${createHash("sha256").update(content, "utf8").digest("hex").slice(0, 32)}"`;
}

const hrefOf = (owner: string, calId: string, file: string) =>
  `/calendars/${owner}/${calId}/${file}`;

let dbInstance: DatabaseSync | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS principals (
  username TEXT PRIMARY KEY, email TEXT, displayname TEXT,
  password_hash TEXT, status TEXT NOT NULL DEFAULT 'active',
  oidc_subject TEXT, managed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS calendars (
  owner TEXT NOT NULL, id TEXT NOT NULL, displayname TEXT NOT NULL,
  color TEXT, seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, id)
);
CREATE TABLE IF NOT EXISTS calendar_acl (
  owner TEXT NOT NULL, cal_id TEXT NOT NULL, username TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('read','write')),
  PRIMARY KEY (owner, cal_id, username)
);
CREATE TABLE IF NOT EXISTS events (
  href TEXT PRIMARY KEY, owner TEXT NOT NULL, cal_id TEXT NOT NULL,
  file TEXT NOT NULL, uid TEXT, dtstart TEXT, dtend TEXT, rrule TEXT,
  summary TEXT, organizer TEXT, etag TEXT NOT NULL, content TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_uid ON events(uid);
CREATE INDEX IF NOT EXISTS idx_events_cal ON events(owner, cal_id, file);
CREATE TABLE IF NOT EXISTS event_attendees (
  href TEXT NOT NULL, attendee TEXT NOT NULL, partstat TEXT NOT NULL,
  response_due TEXT,
  PRIMARY KEY (href, attendee)
);
CREATE INDEX IF NOT EXISTS idx_attendees_partstat
  ON event_attendees(partstat, response_due);
CREATE TABLE IF NOT EXISTS journal (
  owner TEXT NOT NULL, cal_id TEXT NOT NULL, seq INTEGER NOT NULL,
  file TEXT NOT NULL, etag TEXT NOT NULL, deleted INTEGER NOT NULL,
  PRIMARY KEY (owner, cal_id, seq)
);
CREATE TABLE IF NOT EXISTS occurrences (
  href TEXT NOT NULL, owner TEXT NOT NULL, cal_id TEXT NOT NULL,
  uid TEXT, recurrence_id TEXT, dtstart_ms INTEGER NOT NULL,
  dtend_ms INTEGER NOT NULL, transparent INTEGER NOT NULL,
  cancelled INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_occurrences_range
  ON occurrences(owner, cal_id, dtstart_ms, dtend_ms);
CREATE INDEX IF NOT EXISTS idx_occurrences_href ON occurrences(href);
`;

function db(): DatabaseSync {
  if (dbInstance) return dbInstance;
  const path = sqlitePath();
  mkdirSync(dirname(path), { recursive: true });
  const d = new DatabaseSync(path);
  d.exec("PRAGMA journal_mode=WAL");
  d.exec("PRAGMA busy_timeout=5000");
  d.exec(SCHEMA);
  upgradePrincipalsTable(d);
  dbInstance = d;
  seedPrincipalsFromFile();
  // Empty DB in a data dir that still holds the file-store layout: import
  // it once so flipping CALDAV_STORE never strands existing calendars.
  const count = d.prepare("SELECT COUNT(*) AS n FROM calendars").get() as unknown as { n: number };
  if (count.n === 0) {
    const r = migrateFileStoreToSqlite();
    if (r.calendars > 0) {
      console.log(`[caldav-hono] sqlite: auto-imported file store (${r.calendars} calendars, ${r.events} events)`);
    }
  }
  return d;
}

export function closeSqlite(): void {
  dbInstance?.close();
  dbInstance = null;
}

// Databases created before the admin plane had a three-column principals
// table; add what is missing in place (CREATE TABLE IF NOT EXISTS is a
// no-op for them).
function upgradePrincipalsTable(d: DatabaseSync): void {
  const cols = new Set(
    (d.prepare("PRAGMA table_info(principals)").all() as unknown as { name: string }[]).map((c) => c.name),
  );
  const add: Record<string, string> = {
    password_hash: "TEXT",
    status: "TEXT NOT NULL DEFAULT 'active'",
    oidc_subject: "TEXT",
    managed: "INTEGER NOT NULL DEFAULT 0",
    created_at: "TEXT",
    updated_at: "TEXT",
  };
  for (const [name, type] of Object.entries(add)) {
    if (!cols.has(name)) d.exec(`ALTER TABLE principals ADD COLUMN ${name} ${type}`);
  }
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_principals_oidc ON principals(oidc_subject) WHERE oidc_subject IS NOT NULL");
  // Deleted usernames are remembered so ID allocation never hands a
  // number out twice (old ATTENDEE lines and journals may still name it).
  d.exec("CREATE TABLE IF NOT EXISTS principal_tombstones (username TEXT PRIMARY KEY, deleted_at TEXT NOT NULL)");
}

// --- principals ----------------------------------------------------------------

interface PrincipalRow {
  username: string; email: string | null; displayname: string | null;
  password_hash: string | null; status: string; oidc_subject: string | null;
  managed: number; created_at: string | null; updated_at: string | null;
}

const PRINCIPAL_COLS =
  "username,email,displayname,password_hash,status,oidc_subject,managed,created_at,updated_at";

function accountOf(r: PrincipalRow): Account {
  return {
    username: r.username,
    password: "",
    passwordHash: r.password_hash,
    email: r.email ?? undefined,
    displayName: r.displayname ?? undefined,
    status: r.status === "disabled" ? "disabled" : "active",
    oidcSubject: r.oidc_subject,
  };
}

// The accounts file seeds the table. Entries the admin plane has not
// taken over (managed = 0) follow the file on every open, so the plain
// workflow of editing the file and restarting keeps working; a principal
// touched by the admin plane is owned by the table from then on.
function seedPrincipalsFromFile(): void {
  const d = dbInstance as DatabaseSync;
  const now = new Date().toISOString();
  const sel = d.prepare(`SELECT ${PRINCIPAL_COLS} FROM principals WHERE username=?`);
  const ins = d.prepare(
    "INSERT INTO principals(username,email,displayname,password_hash,status,oidc_subject,managed,created_at,updated_at) " +
    "VALUES(?,?,?,?,'active',NULL,0,?,?)",
  );
  const upd = d.prepare(
    "UPDATE principals SET email=?, displayname=?, password_hash=?, updated_at=? WHERE username=? AND managed=0",
  );
  for (const a of readAccountsFile()) {
    const row = sel.get(a.username) as unknown as PrincipalRow | undefined;
    if (!row) {
      ins.run(a.username, a.email ?? null, a.displayName ?? null, hashPassword(a.password), now, now);
      continue;
    }
    if (row.managed !== 0) continue;
    const sameHash = row.password_hash !== null && verifyPassword(a.password, row.password_hash);
    const hash = sameHash ? row.password_hash : hashPassword(a.password);
    if (sameHash && row.email === (a.email ?? null) && row.displayname === (a.displayName ?? null)) continue;
    upd.run(a.email ?? null, a.displayName ?? null, hash, now, a.username);
  }
}

export function listPrincipals(): Account[] {
  const rows = db().prepare(`SELECT ${PRINCIPAL_COLS} FROM principals ORDER BY username`)
    .all() as unknown as PrincipalRow[];
  return rows.map(accountOf);
}

export function getPrincipal(username: string): Account | null {
  const row = db().prepare(`SELECT ${PRINCIPAL_COLS} FROM principals WHERE username=?`)
    .get(username) as unknown as PrincipalRow | undefined;
  return row ? accountOf(row) : null;
}

export function findPrincipalByOidcSubject(sub: string): Account | null {
  const row = db().prepare(`SELECT ${PRINCIPAL_COLS} FROM principals WHERE oidc_subject=?`)
    .get(sub) as unknown as PrincipalRow | undefined;
  return row ? accountOf(row) : null;
}

export interface PrincipalInput {
  username: string;
  email: string | null;
  displayName: string | null;
  passwordHash: string | null;
  status?: PrincipalStatus;
  oidcSubject?: string | null;
}

// Admin-plane create: fails if the username exists.
export function createPrincipal(p: PrincipalInput): Account {
  return tx(() => {
    const d = db();
    const now = new Date().toISOString();
    d.prepare(
      "INSERT INTO principals(username,email,displayname,password_hash,status,oidc_subject,managed,created_at,updated_at) " +
      "VALUES(?,?,?,?,?,?,1,?,?)",
    ).run(p.username, p.email, p.displayName, p.passwordHash, p.status ?? "active", p.oidcSubject ?? null, now, now);
    return getPrincipal(p.username) as Account;
  });
}

export interface PrincipalPatch {
  email?: string | null;
  displayName?: string | null;
  passwordHash?: string | null;
  status?: PrincipalStatus;
  oidcSubject?: string | null;
}

// Admin-plane update: marks the row managed so the accounts file no
// longer overrides it at open.
export function updatePrincipal(username: string, patch: PrincipalPatch): Account | null {
  return tx(() => {
    const d = db();
    const current = getPrincipal(username);
    if (!current) return null;
    d.prepare(
      "UPDATE principals SET email=?, displayname=?, password_hash=?, status=?, oidc_subject=?, managed=1, updated_at=? WHERE username=?",
    ).run(
      patch.email !== undefined ? patch.email : (current.email ?? null),
      patch.displayName !== undefined ? patch.displayName : (current.displayName ?? null),
      patch.passwordHash !== undefined ? patch.passwordHash : (current.passwordHash ?? null),
      patch.status ?? current.status ?? "active",
      patch.oidcSubject !== undefined ? patch.oidcSubject : (current.oidcSubject ?? null),
      new Date().toISOString(),
      username,
    );
    return getPrincipal(username);
  });
}

// Removes the principal, every calendar it owns (events, journal,
// projections, ACL) and every grant it holds on other calendars.
export function deletePrincipal(username: string): boolean {
  return tx(() => {
    const d = db();
    if (!getPrincipal(username)) return false;
    const cals = d.prepare("SELECT id FROM calendars WHERE owner=?").all(username) as unknown as { id: string }[];
    for (const c of cals) deleteCalendar(username, c.id);
    d.prepare("DELETE FROM calendar_acl WHERE username=?").run(username);
    d.prepare("DELETE FROM principals WHERE username=?").run(username);
    d.prepare("INSERT OR REPLACE INTO principal_tombstones(username,deleted_at) VALUES(?,?)")
      .run(username, new Date().toISOString());
    return true;
  });
}

// Every username ever seen (principals, calendar owners, deleted
// principals), so ID allocation never reuses a number.
export function knownUsernames(): string[] {
  const d = db();
  const a = d.prepare("SELECT username FROM principals").all() as unknown as { username: string }[];
  const b = d.prepare("SELECT DISTINCT owner AS username FROM calendars").all() as unknown as { username: string }[];
  const t = d.prepare("SELECT username FROM principal_tombstones").all() as unknown as { username: string }[];
  return [...new Set([...a, ...b, ...t].map((r) => r.username))];
}

// Reentrant: a store call made from inside another store call's
// transaction joins it instead of trying to open a second one.
let txDepth = 0;
function tx<T>(fn: () => T): T {
  const d = db();
  if (txDepth > 0) return fn();
  d.exec("BEGIN IMMEDIATE");
  txDepth += 1;
  try {
    const r = fn();
    d.exec("COMMIT");
    return r;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  } finally {
    txDepth -= 1;
  }
}

// --- calendars --------------------------------------------------------------

interface CalRow {
  owner: string; id: string; displayname: string; color: string | null; seq: number;
}

function metaOf(d: DatabaseSync, row: CalRow): CalendarMeta {
  const acl = d.prepare(
    "SELECT username, access FROM calendar_acl WHERE owner=? AND cal_id=? ORDER BY username",
  ).all(row.owner, row.id) as unknown as { username: string; access: string }[];
  return {
    id: row.id, owner: row.owner, displayname: row.displayname,
    color: row.color, seq: row.seq,
    readers: acl.filter((a) => a.access === "read").map((a) => a.username),
    writers: acl.filter((a) => a.access === "write").map((a) => a.username),
  };
}

function writeAcl(d: DatabaseSync, meta: CalendarMeta): void {
  d.prepare("DELETE FROM calendar_acl WHERE owner=? AND cal_id=?").run(meta.owner, meta.id);
  const ins = d.prepare(
    "INSERT INTO calendar_acl(owner,cal_id,username,access) VALUES(?,?,?,?)",
  );
  for (const u of meta.readers) ins.run(meta.owner, meta.id, u, "read");
  for (const u of meta.writers) ins.run(meta.owner, meta.id, u, "write");
}

export function getCalendar(owner: string, calId: string): CalendarMeta | null {
  const d = db();
  const row = d.prepare(
    "SELECT owner,id,displayname,color,seq FROM calendars WHERE owner=? AND id=?",
  ).get(owner, calId) as unknown as CalRow | undefined;
  return row ? metaOf(d, row) : null;
}

export function createCalendar(meta: Omit<CalendarMeta, "seq">): CalendarMeta {
  return tx(() => {
    const d = db();
    d.prepare(
      "INSERT INTO calendars(owner,id,displayname,color,seq) VALUES(?,?,?,?,0)",
    ).run(meta.owner, meta.id, meta.displayname, meta.color);
    const full: CalendarMeta = { ...meta, seq: 0 };
    writeAcl(d, full);
    return full;
  });
}

export function updateCalendar(meta: CalendarMeta): void {
  tx(() => {
    const d = db();
    d.prepare(
      "UPDATE calendars SET displayname=?, color=? WHERE owner=? AND id=?",
    ).run(meta.displayname, meta.color, meta.owner, meta.id);
    writeAcl(d, meta);
    // seq only moves through event mutations; reflect the stored value.
    const row = d.prepare("SELECT seq FROM calendars WHERE owner=? AND id=?")
      .get(meta.owner, meta.id) as unknown as { seq: number } | undefined;
    if (row) meta.seq = row.seq;
  });
}

export function deleteCalendar(owner: string, calId: string): boolean {
  return tx(() => {
    const d = db();
    const exists = d.prepare("SELECT 1 AS x FROM calendars WHERE owner=? AND id=?")
      .get(owner, calId);
    if (!exists) return false;
    d.prepare("DELETE FROM event_attendees WHERE href IN (SELECT href FROM events WHERE owner=? AND cal_id=?)").run(owner, calId);
    d.prepare("DELETE FROM occurrences WHERE owner=? AND cal_id=?").run(owner, calId);
    d.prepare("DELETE FROM events WHERE owner=? AND cal_id=?").run(owner, calId);
    d.prepare("DELETE FROM journal WHERE owner=? AND cal_id=?").run(owner, calId);
    d.prepare("DELETE FROM calendar_acl WHERE owner=? AND cal_id=?").run(owner, calId);
    d.prepare("DELETE FROM calendars WHERE owner=? AND id=?").run(owner, calId);
    return true;
  });
}

export function listCalendars(owner: string): CalendarMeta[] {
  const d = db();
  const rows = d.prepare(
    "SELECT owner,id,displayname,color,seq FROM calendars WHERE owner=? ORDER BY id",
  ).all(owner) as unknown as CalRow[];
  return rows.map((r) => metaOf(d, r));
}

export function sharedCalendars(username: string): CalendarMeta[] {
  const d = db();
  const rows = d.prepare(
    "SELECT c.owner,c.id,c.displayname,c.color,c.seq FROM calendars c " +
    "JOIN calendar_acl a ON a.owner=c.owner AND a.cal_id=c.id " +
    "WHERE a.username=? AND c.owner<>? ORDER BY c.owner, c.id",
  ).all(username, username) as unknown as CalRow[];
  return rows.map((r) => metaOf(d, r));
}

// --- events -------------------------------------------------------------------

interface EventRow {
  file: string; content: string; etag: string; owner: string; cal_id: string;
}

// (Re)build the derived rows for one resource: index columns on events are
// written by the caller; this rebuilds attendees + occurrence projection.
function reindexTx(d: DatabaseSync, owner: string, calId: string, file: string, content: string): void {
  const href = hrefOf(owner, calId, file);
  d.prepare("DELETE FROM event_attendees WHERE href=?").run(href);
  d.prepare("DELETE FROM occurrences WHERE href=?").run(href);
  const insAtt = d.prepare(
    "INSERT OR REPLACE INTO event_attendees(href,attendee,partstat,response_due) VALUES(?,?,?,?)",
  );
  for (const a of attendeesOf(content)) {
    insAtt.run(href, a.address, a.partstat, a.responseDue);
  }
  const insOcc = d.prepare(
    "INSERT INTO occurrences(href,owner,cal_id,uid,recurrence_id,dtstart_ms,dtend_ms,transparent,cancelled) " +
    "VALUES(?,?,?,?,?,?,?,?,?)",
  );
  // Full-range expansion (engine caps at ~10y / 10000 rows). EXDATE and
  // RECURRENCE-ID overrides are already applied by expandCalendar.
  const expansion = expandCalendar(content, null, null);
  for (const occ of expansion.occurrences) {
    const rid = occ.recurrenceIdLine
      ? occ.recurrenceIdLine.slice(occ.recurrenceIdLine.indexOf(":") + 1)
      : null;
    insOcc.run(
      href, owner, calId, occ.uid || null, rid,
      occ.start.getTime(), occ.end.getTime(),
      occ.transparent ? 1 : 0, occ.cancelled ? 1 : 0,
    );
  }
}

// Insert/replace one event without touching seq/journal (migration path).
function insertEventTx(d: DatabaseSync, owner: string, calId: string, file: string, content: string): StoredEvent {
  const etag = etagOf(content);
  const master = masterEvent(content);
  const col = (name: string) => (master ? propOf(master, name)?.value.trim() ?? null : null);
  const organizer = master ? propOf(master, "ORGANIZER")?.value : undefined;
  d.prepare(
    "INSERT INTO events(href,owner,cal_id,file,uid,dtstart,dtend,rrule,summary,organizer,etag,content) " +
    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(href) DO UPDATE SET " +
    "uid=excluded.uid, dtstart=excluded.dtstart, dtend=excluded.dtend, " +
    "rrule=excluded.rrule, summary=excluded.summary, organizer=excluded.organizer, " +
    "etag=excluded.etag, content=excluded.content",
  ).run(
    hrefOf(owner, calId, file), owner, calId, file,
    col("UID"), col("DTSTART"), col("DTEND"), col("RRULE"), col("SUMMARY"),
    organizer ? normAddr(organizer) : null,
    etag, content,
  );
  reindexTx(d, owner, calId, file, content);
  return { file, content, etag };
}

function bumpTx(d: DatabaseSync, meta: CalendarMeta, file: string, etag: string, deleted: boolean): void {
  d.prepare("UPDATE calendars SET seq=seq+1 WHERE owner=? AND id=?").run(meta.owner, meta.id);
  const row = d.prepare("SELECT seq FROM calendars WHERE owner=? AND id=?")
    .get(meta.owner, meta.id) as unknown as { seq: number };
  d.prepare("INSERT INTO journal(owner,cal_id,seq,file,etag,deleted) VALUES(?,?,?,?,?,?)")
    .run(meta.owner, meta.id, row.seq, file, etag, deleted ? 1 : 0);
  meta.seq = row.seq;
}

function putEventTx(meta: CalendarMeta, file: string, content: string): StoredEvent {
  const d = db();
  // Mirror the file store: writing into a calendar the meta describes
  // creates it if the row is somehow absent.
  d.prepare(
    "INSERT OR IGNORE INTO calendars(owner,id,displayname,color,seq) VALUES(?,?,?,?,0)",
  ).run(meta.owner, meta.id, meta.displayname, meta.color);
  const stored = insertEventTx(d, meta.owner, meta.id, file, content);
  bumpTx(d, meta, file, stored.etag, false);
  return stored;
}

export function getEvent(meta: CalendarMeta, file: string): StoredEvent | null {
  const row = db().prepare(
    "SELECT file,content,etag,owner,cal_id FROM events WHERE href=?",
  ).get(hrefOf(meta.owner, meta.id, file)) as unknown as EventRow | undefined;
  return row ? { file: row.file, content: row.content, etag: row.etag } : null;
}

export function listEvents(meta: CalendarMeta): StoredEvent[] {
  const rows = db().prepare(
    "SELECT file,content,etag,owner,cal_id FROM events WHERE owner=? AND cal_id=? ORDER BY file",
  ).all(meta.owner, meta.id) as unknown as EventRow[];
  return rows.map((r) => ({ file: r.file, content: r.content, etag: r.etag }));
}

export function putEvent(meta: CalendarMeta, file: string, content: string): StoredEvent {
  return tx(() => putEventTx(meta, file, content));
}

export function deleteEvent(meta: CalendarMeta, file: string): boolean {
  return tx(() => {
    const d = db();
    const ev = getEvent(meta, file);
    if (!ev) return false;
    const href = hrefOf(meta.owner, meta.id, file);
    d.prepare("DELETE FROM event_attendees WHERE href=?").run(href);
    d.prepare("DELETE FROM occurrences WHERE href=?").run(href);
    d.prepare("DELETE FROM events WHERE href=?").run(href);
    bumpTx(d, meta, file, ev.etag, true); // tombstone journal row
    return true;
  });
}

export function journalSince(meta: CalendarMeta, sinceSeq: number): JournalEntry[] {
  const rows = db().prepare(
    "SELECT seq,file,etag,deleted FROM journal WHERE owner=? AND cal_id=? AND seq>? ORDER BY seq",
  ).all(meta.owner, meta.id, sinceSeq) as unknown as
    { seq: number; file: string; etag: string; deleted: number }[];
  const byFile = new Map<string, JournalEntry>();
  for (const r of rows) {
    byFile.set(r.file, { seq: r.seq, file: r.file, etag: r.etag, deleted: r.deleted !== 0 });
  }
  return [...byFile.values()].sort((a, b) => a.seq - b.seq);
}

export function findEventsByUid(uid: string): LocatedEvent[] {
  const d = db();
  const rows = d.prepare(
    "SELECT file,content,etag,owner,cal_id FROM events WHERE uid=? ORDER BY owner, cal_id, file",
  ).all(uid) as unknown as EventRow[];
  const out: LocatedEvent[] = [];
  for (const r of rows) {
    const meta = getCalendar(r.owner, r.cal_id);
    if (meta) out.push({ meta, event: { file: r.file, content: r.content, etag: r.etag } });
  }
  return out;
}

// Server-side PARTSTAT application (RFC 6638 corrected model: the server,
// not the attendee, edits the organizer's master). An ACCEPTED reply is a
// conditional update inside the transaction: it only lands when no other
// attendee has already ACCEPTED this resource (first-come wins a
// single-assignee offer), so a late accept can never overwrite the winner.
export function applyPartstatReply(
  meta: CalendarMeta, file: string, attendeeAddress: string, partstat: string,
): ReplyResult {
  return tx(() => {
    const d = db();
    const href = hrefOf(meta.owner, meta.id, file);
    const addr = attendeeAddress.trim().toLowerCase();
    const row = d.prepare("SELECT content FROM events WHERE href=?").get(href) as
      unknown as { content: string } | undefined;
    if (!row) return { applied: false, reason: "not-found" };
    const mine = attendeesOf(row.content).find((a) => a.address === addr);
    if (!mine) return { applied: false, reason: "not-attendee" };
    if (partstat === "ACCEPTED" && mine.partstat !== "ACCEPTED") {
      const claim = d.prepare(
        "UPDATE event_attendees SET partstat='ACCEPTED' WHERE href=? AND attendee=? " +
        "AND NOT EXISTS (SELECT 1 FROM event_attendees WHERE href=? AND partstat='ACCEPTED' AND attendee<>?)",
      ).run(href, addr, href, addr);
      if (claim.changes === 0) return { applied: false, reason: "already-accepted" };
    }
    const stored = putEventTx(meta, file, setAttendeePartstat(row.content, addr, partstat));
    return { applied: true, stored };
  });
}

// --- migration from the file store -------------------------------------------

export interface MigrationResult { calendars: number; events: number; skipped: number }

// Import calendars/<owner>/<cal>/ (meta.json + events/*.ics + journal.jsonl)
// under CALDAV_DATA into SQLite, preserving seq and journal so existing
// sync-tokens stay meaningful. Idempotent: calendars already present are
// skipped, so it is safe to re-run.
export function migrateFileStoreToSqlite(): MigrationResult {
  const base = join(dataDirLocal(), "calendars");
  const result: MigrationResult = { calendars: 0, events: 0, skipped: 0 };
  if (!existsSync(base)) return result;
  const d = db();
  return tx(() => {
    for (const ownerEnt of readdirSync(base, { withFileTypes: true })) {
      if (!ownerEnt.isDirectory()) continue;
      for (const calEnt of readdirSync(join(base, ownerEnt.name), { withFileTypes: true })) {
        if (!calEnt.isDirectory()) continue;
        const dir = join(base, ownerEnt.name, calEnt.name);
        const metaPath = join(dir, "meta.json");
        if (!existsSync(metaPath)) continue;
        const meta = JSON.parse(readFileSync(metaPath, "utf8")) as CalendarMeta;
        const present = d.prepare("SELECT 1 AS x FROM calendars WHERE owner=? AND id=?")
          .get(meta.owner, meta.id);
        if (present) { result.skipped += 1; continue; }
        d.prepare("INSERT INTO calendars(owner,id,displayname,color,seq) VALUES(?,?,?,?,?)")
          .run(meta.owner, meta.id, meta.displayname, meta.color, meta.seq);
        writeAcl(d, meta);
        const evDir = join(dir, "events");
        if (existsSync(evDir)) {
          for (const f of readdirSync(evDir).filter((x) => x.endsWith(".ics")).sort()) {
            insertEventTx(d, meta.owner, meta.id, f, readFileSync(join(evDir, f), "utf8"));
            result.events += 1;
          }
        }
        const journalPath = join(dir, "journal.jsonl");
        if (existsSync(journalPath)) {
          const ins = d.prepare(
            "INSERT OR IGNORE INTO journal(owner,cal_id,seq,file,etag,deleted) VALUES(?,?,?,?,?,?)",
          );
          for (const line of readFileSync(journalPath, "utf8").split("\n")) {
            if (!line.trim()) continue;
            const e = JSON.parse(line) as JournalEntry;
            ins.run(meta.owner, meta.id, e.seq, e.file, e.etag, e.deleted ? 1 : 0);
          }
        }
        result.calendars += 1;
      }
    }
    return result;
  });
}
