// Implicit scheduling (RFC 6638 subset, same-server only), modelled on
// RFC 5546/6638 and measured Stalwart behaviour - no external code.
//
// Model (corrected response flow): an attendee never edits the
// organizer's resource. The attendee edits their own copy; the server
// turns a PARTSTAT change into an iTIP REPLY (delivered to the
// organizer's schedule-inbox) and applies it to the master itself via
// store.applyPartstatReply (conditional, first ACCEPTED wins).
//
// One resource per UID in an attendee's default calendar: delivery
// updates whatever resource already carries the UID there (whatever its
// file name) instead of adding a second one, and the PUT handler folds an
// operator direct-write of an invitation onto the server-delivered copy
// (see app.ts). Delivery is the only path that should create copies; the
// direct write survives solely for the legacy replay script (offer-flow).
//
// Inbox policy: the schedule-inbox is a pending/recent-message list, not
// a calendar. Per inbox and UID only the latest organizer message
// (REQUEST/CANCEL) and the latest REPLY per attendee are kept; an
// attendee's REQUEST is removed once they answered (or deleted the
// copy); anything older than CALDAV_INBOX_RETENTION_DAYS (default 30,
// 0 = keep forever) is swept on delivery and at startup. The inbox is
// not listed in the calendar home and is not a CALDAV:calendar, so
// DAVx5-style clients never see it; the principal advertises it via
// schedule-inbox-URL.
//
// Hooks run after successful PUT/DELETE in the handlers. All server-side
// writes go straight through the store, so they never re-enter the hooks.
// MOVE deliberately does not trigger scheduling (stage moves are an
// operator-side bookkeeping act, not an invitation change). Events
// without ORGANIZER/ATTENDEE, external (unmapped) addresses, and
// ATTENDEEs with SCHEDULE-AGENT=CLIENT/NONE are left alone. Occurrence-
// level (RECURRENCE-ID) replies are out of scope: master component only.

import { loadAccounts, type Account } from "./auth.js";
import {
  attendeesOf, buildReplyCalendar, dtstampOf, firstUid, markCancelled, normAddr,
  organizerAddress, parseCalendar, restamp, stripMethod, withMethod,
} from "./ical.js";
import {
  applyPartstatReply, createCalendar, deleteEvent, eventsWithUid, findEventsByUid,
  getCalendar, getEvent, listEvents, putEvent, type CalendarMeta, type StoredEvent,
} from "./store.js";

export const INBOX_ID = "inbox";

export function addressOfAccount(account: Account): string {
  return `mailto:${(account.email ?? `${account.username}@example.test`).toLowerCase()}`;
}

export function accountForAddress(address: string): Account | null {
  const addr = normAddr(address);
  return loadAccounts().find((a) => addressOfAccount(a) === addr) ?? null;
}

export function ensureInbox(username: string): CalendarMeta {
  return getCalendar(username, INBOX_ID) ?? createCalendar({
    id: INBOX_ID, owner: username, displayname: "Inbox", color: null,
    readers: [], writers: [],
  });
}

function ensureDefaultCalendar(account: Account): CalendarMeta {
  return getCalendar(account.username, "default") ?? createCalendar({
    id: "default", owner: account.username,
    displayname: account.displayName ?? account.username, color: null,
    readers: [], writers: [],
  });
}

// Server-delivered copies carry a UID-derived file name so they never
// collide with resources the attendee (or an operator direct-write, the
// legacy offer path) placed under a name of their own choosing.
export function copyFileName(uid: string): string {
  return `${uid.replace(/[^A-Za-z0-9@._-]/g, "_")}.ics`;
}

// --- inbox ---------------------------------------------------------------------

export function inboxRetentionMs(): number {
  const days = Number(process.env.CALDAV_INBOX_RETENTION_DAYS ?? "30");
  if (!Number.isFinite(days) || days <= 0) return 0;
  return days * 24 * 3_600_000;
}

function methodOf(content: string): string | null {
  const m = parseCalendar(content).calendarProps.find((p) => p.name === "METHOD");
  return m ? m.value.trim().toUpperCase() : null;
}

// Which earlier messages a new one supersedes: organizer messages
// (REQUEST/CANCEL) share one slot per UID; REPLYs one slot per attendee.
function slotOf(content: string): string | null {
  const method = methodOf(content);
  const uid = firstUid(content);
  if (!method || !uid) return null;
  if (method === "REPLY") {
    const att = attendeesOf(content)[0];
    return `${uid}|reply|${att?.address ?? "?"}`;
  }
  return `${uid}|organizer`;
}

// Drop messages past retention. Called on every delivery to that inbox
// and once at startup for every principal (index.ts).
export function sweepInbox(inbox: CalendarMeta, now = new Date()): number {
  const retention = inboxRetentionMs();
  if (retention <= 0) return 0;
  let removed = 0;
  for (const ev of listEvents(inbox)) {
    const stamp = dtstampOf(ev.content);
    if (stamp && now.getTime() - stamp.getTime() > retention) {
      deleteEvent(inbox, ev.file);
      removed += 1;
    }
  }
  return removed;
}

export function sweepAllInboxes(now = new Date()): number {
  let removed = 0;
  for (const a of loadAccounts()) {
    const inbox = getCalendar(a.username, INBOX_ID);
    if (inbox) removed += sweepInbox(inbox, now);
  }
  return removed;
}

// Remove the organizer-side messages (REQUEST) for a UID from an
// attendee's inbox once they have answered: the inbox then lists only
// what still needs action.
function clearAnswered(username: string, uid: string): void {
  const inbox = getCalendar(username, INBOX_ID);
  if (!inbox) return;
  for (const ev of eventsWithUid(inbox, uid)) {
    if (methodOf(ev.content) === "REQUEST") deleteEvent(inbox, ev.file);
  }
}

let inboxSeq = 0;
function deliverToInbox(username: string, method: string, uid: string, content: string): void {
  const inbox = ensureInbox(username);
  const now = new Date();
  const message = restamp(content, now);
  const slot = slotOf(message);
  for (const ev of eventsWithUid(inbox, uid)) {
    if (slotOf(ev.content) === slot) deleteEvent(inbox, ev.file);
  }
  inboxSeq += 1;
  const file = `${copyFileName(uid).slice(0, -4)}-${method.toLowerCase()}-${now.getTime().toString(36)}-${inboxSeq}.ics`;
  putEvent(inbox, file, message);
  sweepInbox(inbox, now);
}

// --- copies in attendee default calendars ----------------------------------------

// The attendee's resource for this UID in their default calendar, if any:
// the server-delivered copy or an operator direct-write (same thing to
// the attendee).
function attendeeCopies(attendee: Account, uid: string): { cal: CalendarMeta; events: StoredEvent[] } | null {
  const cal = getCalendar(attendee.username, "default");
  if (!cal) return null;
  return { cal, events: eventsWithUid(cal, uid) };
}

function deliverRequest(attendee: Account, uid: string, masterContent: string): void {
  deliverToInbox(attendee.username, "REQUEST", uid, withMethod(masterContent, "REQUEST"));
  const cal = ensureDefaultCalendar(attendee);
  const existing = eventsWithUid(cal, uid);
  const content = stripMethod(masterContent);
  if (existing.length === 0) {
    putEvent(cal, copyFileName(uid), content);
    return;
  }
  // Update in place; collapse any extra same-UID resources onto the first.
  putEvent(cal, existing[0].file, content);
  for (const extra of existing.slice(1)) deleteEvent(cal, extra.file);
}

function deliverCancel(attendee: Account, uid: string, content: string): void {
  deliverToInbox(attendee.username, "CANCEL", uid, withMethod(markCancelled(content), "CANCEL"));
}

function removeCopies(attendee: Account, uid: string): void {
  const found = attendeeCopies(attendee, uid);
  if (!found) return;
  for (const ev of found.events) deleteEvent(found.cal, ev.file);
}

// Refresh attendee copies from the (just updated) master so every
// attendee sees current PARTSTATs. Every same-UID resource in an
// attendee's default calendar is a copy (delivered or direct-written);
// the one the acting attendee just wrote is skipped.
function refreshCopies(uid: string, organizer: Account, masterContent: string, skip?: { owner: string; calId: string; file: string }): void {
  for (const att of attendeesOf(masterContent)) {
    const acct = accountForAddress(att.address);
    if (!acct || acct.username === organizer.username) continue;
    const found = attendeeCopies(acct, uid);
    if (!found) continue;
    for (const ev of found.events) {
      if (skip && skip.owner === acct.username && skip.calId === found.cal.id && skip.file === ev.file) continue;
      putEvent(found.cal, ev.file, stripMethod(masterContent));
    }
  }
}

interface SchedContext {
  uid: string;
  organizerAddr: string;
  organizer: Account;
}

function contextOf(content: string): SchedContext | null {
  const uid = firstUid(content);
  const org = organizerAddress(content);
  if (!uid || !org) return null;
  const organizer = accountForAddress(org);
  if (!organizer) return null; // external organizer: iMIP is out of scope
  if (attendeesOf(content).length === 0) return null;
  return { uid, organizerAddr: org, organizer };
}

// True when `content` written by `actor` into `meta` is the organizer
// writing an invitation into an attendee's calendar (the legacy
// direct-write offer path), as opposed to the organizer's own master.
export function isOrganizerDirectWrite(actor: Account, meta: CalendarMeta, content: string): boolean {
  const ctx = contextOf(content);
  if (!ctx) return false;
  if (actor.username !== ctx.organizer.username) return false;
  if (meta.owner === ctx.organizer.username) return false;
  const ownerAcct = loadAccounts().find((a) => a.username === meta.owner);
  if (!ownerAcct) return false;
  const ownerAddr = addressOfAccount(ownerAcct);
  return attendeesOf(content).some((a) => a.address === ownerAddr);
}

function applyReplyToMasters(
  ctx: SchedContext, attendeeAddr: string, partstat: string,
  skip?: { owner: string; calId: string; file: string },
): void {
  const masters = findEventsByUid(ctx.uid)
    .filter((l) => l.meta.owner === ctx.organizer.username && l.meta.id !== INBOX_ID && organizerAddress(l.event.content) === ctx.organizerAddr);
  for (const m of masters) {
    const res = applyPartstatReply(m.meta, m.event.file, attendeeAddr, partstat);
    if (res.applied && res.stored) {
      refreshCopies(ctx.uid, ctx.organizer, res.stored.content, skip);
    } else {
      console.warn(`[caldav-hono] scheduling reply not applied uid=${ctx.uid} attendee=${attendeeAddr} partstat=${partstat} reason=${res.reason ?? "?"}`);
    }
  }
}

export function onEventPut(
  actor: Account, meta: CalendarMeta, file: string,
  oldContent: string | null, newContent: string,
): void {
  try {
    if (meta.id === INBOX_ID) return; // messages, not invitations
    const ctx = contextOf(newContent);
    if (!ctx) return;
    const actorAddr = addressOfAccount(actor);
    const atts = attendeesOf(newContent);

    // Organizer writing the master in their own calendar: deliver.
    if (meta.owner === ctx.organizer.username && actor.username === ctx.organizer.username) {
      const oldAtts = oldContent ? attendeesOf(oldContent) : [];
      for (const att of atts) {
        if (att.scheduleAgent !== "SERVER") continue;
        const acct = accountForAddress(att.address);
        if (!acct || acct.username === ctx.organizer.username) continue;
        deliverRequest(acct, ctx.uid, newContent);
      }
      for (const old of oldAtts) {
        if (atts.some((a) => a.address === old.address)) continue;
        const acct = accountForAddress(old.address);
        if (!acct || acct.username === ctx.organizer.username) continue;
        deliverCancel(acct, ctx.uid, oldContent ?? newContent);
        removeCopies(acct, ctx.uid);
      }
      return;
    }

    // Attendee writing their own copy: a PARTSTAT change becomes a REPLY
    // that the server applies to the organizer's master.
    const mine = atts.find((a) => a.address === actorAddr);
    if (meta.owner === actor.username && mine && actor.username !== ctx.organizer.username) {
      const oldPs = oldContent
        ? attendeesOf(oldContent).find((a) => a.address === actorAddr)?.partstat
        : undefined;
      if (oldContent && oldPs === mine.partstat) return;
      deliverToInbox(ctx.organizer.username, "REPLY", ctx.uid,
        buildReplyCalendar(newContent, actorAddr, mine.partstat));
      if (mine.partstat !== "NEEDS-ACTION") clearAnswered(actor.username, ctx.uid);
      applyReplyToMasters(ctx, actorAddr, mine.partstat,
        { owner: meta.owner, calId: meta.id, file });
    }
  } catch (e) {
    console.error(`[caldav-hono] scheduling onEventPut failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function onEventDelete(
  actor: Account, meta: CalendarMeta, file: string, oldContent: string,
): void {
  try {
    if (meta.id === INBOX_ID) return;
    const ctx = contextOf(oldContent);
    if (!ctx) return;
    const actorAddr = addressOfAccount(actor);

    // Organizer deleted the master: propagate CANCEL, drop attendee copies.
    if (meta.owner === ctx.organizer.username && actor.username === ctx.organizer.username) {
      for (const att of attendeesOf(oldContent)) {
        const acct = accountForAddress(att.address);
        if (acct && acct.username !== ctx.organizer.username) deliverCancel(acct, ctx.uid, oldContent);
      }
      for (const l of findEventsByUid(ctx.uid)) {
        if (l.meta.owner === ctx.organizer.username) continue;
        if (organizerAddress(l.event.content) !== ctx.organizerAddr) continue;
        if (l.meta.id === INBOX_ID) continue;
        deleteEvent(l.meta, l.event.file);
      }
      return;
    }

    // Attendee deleted their own copy: DECLINED towards the organizer.
    const mine = attendeesOf(oldContent).find((a) => a.address === actorAddr);
    if (meta.owner === actor.username && mine && actor.username !== ctx.organizer.username) {
      deliverToInbox(ctx.organizer.username, "REPLY", ctx.uid,
        buildReplyCalendar(oldContent, actorAddr, "DECLINED"));
      clearAnswered(actor.username, ctx.uid);
      applyReplyToMasters(ctx, actorAddr, "DECLINED");
    }
  } catch (e) {
    console.error(`[caldav-hono] scheduling onEventDelete failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
