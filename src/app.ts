// CalDAV subset (RFC 4791 + WebDAV RFC 4918 + sync RFC 6578), clean-room.
// Routes:
//   /.well-known/caldav          -> 307 /dav/cal/
//   /dav/cal/                    -> current-user-principal discovery
//   /principals/<user>/          -> calendar-home-set
//   /calendars/<user>/           -> calendar home (own + shared)
//   /calendars/<user>/<cal>/     -> calendar collection
//   /calendars/<user>/<cal>/<f>.ics -> event resource

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { createAdminApp } from "./admin.js";
import { accessTo, authenticateBasic, isDisabled, loadAccounts, type Account } from "./auth.js";
import { authenticateBearer, oidcEnabled } from "./oidc.js";
import { firstUid, parseCalendar, parseICalDate } from "./ical.js";
import {
  buildFreeBusy, expandCalendar, expandToICalendar, occurrenceOverlaps,
  type RecurrenceDiagnostic,
} from "./recurrence.js";
import {
  INBOX_ID, ensureInbox, isOrganizerDirectWrite, onEventDelete, onEventPut,
} from "./scheduling.js";
import {
  createCalendar, deleteCalendar, deleteEvent, eventsWithUid, getCalendar, getEvent,
  journalSince, listCalendars, listEvents, parseSyncToken, putEvent,
  sharedCalendars, syncToken, updateCalendar, type CalendarMeta, type StoredEvent,
} from "./store.js";
import {
  allHrefTexts, davError, esc, expandRange, multistatus, reportKind,
  tagText, timeRange, wantsCalendarData, type DavResponse,
} from "./xml.js";

const DAV_HEADER = "1, 2, 3, calendar-access, calendar-schedule, sync-collection";
const ALLOW = "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCALENDAR, MKCOL, REPORT, MOVE";

type PathInfo =
  | { kind: "wellknown" }
  | { kind: "root" }
  | { kind: "principal"; user: string }
  | { kind: "home"; user: string }
  | { kind: "calendar"; user: string; calId: string }
  | { kind: "event"; user: string; calId: string; file: string }
  | { kind: "unknown" };

function parsePath(rawPath: string): PathInfo {
  const path = decodeURIComponent(rawPath);
  if (path === "/.well-known/caldav" || path === "/.well-known/caldav/") return { kind: "wellknown" };
  if (path === "/" || path === "/dav/cal" || path === "/dav/cal/") return { kind: "root" };
  const seg = path.split("/").filter((s) => s !== "");
  if (seg[0] === "principals" && seg.length === 2) return { kind: "principal", user: seg[1] };
  if (seg[0] === "calendars") {
    if (seg.length === 2) return { kind: "home", user: seg[1] };
    if (seg.length === 3) return { kind: "calendar", user: seg[1], calId: seg[2] };
    if (seg.length === 4) return { kind: "event", user: seg[1], calId: seg[2], file: seg[3] };
  }
  return { kind: "unknown" };
}

const enc = encodeURIComponent;
const principalHref = (u: string) => `/principals/${enc(u)}/`;
const homeHref = (u: string) => `/calendars/${enc(u)}/`;
const calHref = (m: CalendarMeta) => `/calendars/${enc(m.owner)}/${enc(m.id)}/`;
const eventHref = (m: CalendarMeta, f: string) => `${calHref(m)}${enc(f)}`;

function xml(c: Context, body: string, status = 207) {
  return c.body(body, status as never, {
    "Content-Type": "application/xml; charset=utf-8",
    DAV: DAV_HEADER,
  });
}

function principalProps(account: Account): string {
  const user = account.username;
  return (
    `<D:displayname>${esc(account.displayName ?? user)}</D:displayname>` +
    `<D:resourcetype><D:principal/></D:resourcetype>` +
    `<C:calendar-home-set><D:href>${esc(homeHref(user))}</D:href></C:calendar-home-set>` +
    `<C:calendar-user-address-set><D:href>mailto:${esc(account.email ?? `${user}@example.test`)}</D:href></C:calendar-user-address-set>` +
    `<D:current-user-principal><D:href>${esc(principalHref(user))}</D:href></D:current-user-principal>` +
    `<C:schedule-inbox-URL><D:href>${esc(homeHref(user))}inbox/</D:href></C:schedule-inbox-URL>`
  );
}

function calendarProps(meta: CalendarMeta, requester: string): string {
  const access = accessTo(meta, requester);
  const privs =
    access === "owner" || access === "write"
      ? "<D:privilege><D:all/></D:privilege>"
      : "<D:privilege><D:read/></D:privilege>";
  const color = meta.color ? `<IC:calendar-color>${esc(meta.color)}</IC:calendar-color>` : "";
  // The schedule-inbox is a collection of iTIP messages, not a calendar
  // (RFC 6638 2.2): no CALDAV:calendar in its resourcetype, so calendar
  // clients do not sync it.
  const resourcetype = meta.id === INBOX_ID
    ? "<D:resourcetype><D:collection/><C:schedule-inbox/></D:resourcetype>"
    : "<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>";
  return (
    `<D:displayname>${esc(meta.displayname)}</D:displayname>` +
    resourcetype +
    `<D:current-user-privilege-set>${privs}</D:current-user-privilege-set>` +
    `<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>` +
    `<CS:getctag>${meta.seq}</CS:getctag>` +
    `<D:sync-token>${esc(syncToken(meta))}</D:sync-token>` +
    `<D:supported-report-set>` +
    `<D:supported-report><D:report><C:calendar-query/></D:report></D:supported-report>` +
    `<D:supported-report><D:report><C:calendar-multiget/></D:report></D:supported-report>` +
    `<D:supported-report><D:report><C:free-busy-query/></D:report></D:supported-report>` +
    `<D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report>` +
    `</D:supported-report-set>` +
    color
  );
}

function eventProps(meta: CalendarMeta, ev: StoredEvent, withData: boolean, contentOverride?: string): string {
  const data = withData
    ? `<C:calendar-data>${esc(contentOverride ?? ev.content)}</C:calendar-data>`
    : "";
  return (
    `<D:getetag>${esc(ev.etag)}</D:getetag>` +
    `<D:getcontenttype>text/calendar; charset=utf-8</D:getcontenttype>` +
    `<D:resourcetype/>` +
    data
  );
}

// --- PROPFIND -------------------------------------------------------------

function handlePropfind(c: Context, account: Account, info: PathInfo, body: string) {
  const depth = c.req.header("Depth") ?? "0";
  const me = account.username;
  if (info.kind === "wellknown") return c.redirect("/dav/cal/", 307);
  if (info.kind === "root") {
    return xml(c, multistatus([{
      href: "/dav/cal/",
      propsXml:
        `<D:resourcetype><D:collection/></D:resourcetype>` +
        `<D:current-user-principal><D:href>${esc(principalHref(me))}</D:href></D:current-user-principal>`,
    }]));
  }
  if (info.kind === "principal") {
    if (info.user !== me) return xml(c, davError("<D:need-privileges/>"), 403);
    ensureInbox(me);
    return xml(c, multistatus([{ href: principalHref(me), propsXml: principalProps(account) }]));
  }
  if (info.kind === "home") {
    if (info.user !== me) return xml(c, davError("<D:need-privileges/>"), 403);
    const responses: DavResponse[] = [{
      href: homeHref(me),
      propsXml:
        `<D:displayname>${esc(account.displayName ?? me)}</D:displayname>` +
        `<D:resourcetype><D:collection/></D:resourcetype>` +
        `<D:current-user-principal><D:href>${esc(principalHref(me))}</D:href></D:current-user-principal>`,
    }];
    if (depth !== "0") {
      // The inbox is reached through schedule-inbox-URL, not the home list.
      for (const meta of [...listCalendars(me), ...sharedCalendars(me)]) {
        if (meta.id === INBOX_ID) continue;
        responses.push({ href: calHref(meta), propsXml: calendarProps(meta, me) });
      }
    }
    return xml(c, multistatus(responses));
  }
  if (info.kind === "calendar") {
    const meta = getCalendar(info.user, info.calId);
    if (!meta) return c.body(null, 404);
    if (!accessTo(meta, me)) return xml(c, davError("<D:need-privileges/>"), 403);
    const responses: DavResponse[] = [{ href: calHref(meta), propsXml: calendarProps(meta, me) }];
    if (depth !== "0") {
      for (const ev of listEvents(meta)) {
        responses.push({ href: eventHref(meta, ev.file), propsXml: eventProps(meta, ev, false) });
      }
    }
    return xml(c, multistatus(responses));
  }
  if (info.kind === "event") {
    const meta = getCalendar(info.user, info.calId);
    if (!meta) return c.body(null, 404);
    if (!accessTo(meta, me)) return xml(c, davError("<D:need-privileges/>"), 403);
    const ev = getEvent(meta, info.file);
    if (!ev) return c.body(null, 404);
    return xml(c, multistatus([{
      href: eventHref(meta, ev.file),
      propsXml: eventProps(meta, ev, wantsCalendarData(body)),
    }]));
  }
  return c.body(null, 404);
}

// --- MKCALENDAR / MKCOL / PROPPATCH --------------------------------------

function handleMkcalendar(c: Context, account: Account, info: PathInfo, body: string) {
  if (info.kind !== "calendar") return c.body(null, 409);
  if (info.user !== account.username) return xml(c, davError("<D:need-privileges/>"), 403);
  if (!/^[A-Za-z0-9._-]+$/.test(info.calId)) return c.body("invalid calendar id", 400);
  if (getCalendar(info.user, info.calId)) return c.body(null, 405);
  const displayname = tagText(body, "displayname") || info.calId;
  const color = tagText(body, "calendar-color");
  createCalendar({
    id: info.calId, owner: info.user, displayname,
    color: color || null, readers: [], writers: [],
  });
  return c.body(null, 201, { DAV: DAV_HEADER });
}

function handleProppatch(c: Context, account: Account, info: PathInfo, body: string) {
  if (info.kind !== "calendar") return c.body(null, 404);
  const meta = getCalendar(info.user, info.calId);
  if (!meta) return c.body(null, 404);
  if (meta.owner !== account.username) return xml(c, davError("<D:need-privileges/>"), 403);
  const displayname = tagText(body, "displayname");
  const color = tagText(body, "calendar-color");
  if (displayname) meta.displayname = displayname;
  if (color !== null) meta.color = color || null;
  updateCalendar(meta);
  return xml(c, multistatus([{ href: calHref(meta), propsXml: "" }]));
}

// --- PUT / GET / DELETE / MOVE --------------------------------------------

function etagMatches(headerVal: string, current: string | null): boolean {
  const tags = headerVal.split(",").map((t) => t.trim());
  if (tags.includes("*")) return current !== null;
  return current !== null && tags.includes(current);
}

function checkPreconditions(c: Context, currentEtag: string | null): boolean {
  const ifMatch = c.req.header("If-Match");
  const ifNoneMatch = c.req.header("If-None-Match");
  if (ifMatch && !etagMatches(ifMatch, currentEtag)) return false;
  if (ifNoneMatch) {
    const tags = ifNoneMatch.split(",").map((t) => t.trim());
    if (currentEtag !== null && (tags.includes("*") || tags.includes(currentEtag))) return false;
  }
  return true;
}

function requireCalendar(c: Context, account: Account, info: { user: string; calId: string }, needWrite: boolean) {
  const meta = getCalendar(info.user, info.calId);
  if (!meta) return { error: c.body(null, 404) };
  const access = accessTo(meta, account.username);
  if (!access || (needWrite && access === "read")) {
    return { error: xml(c, davError("<D:need-privileges/>"), 403) };
  }
  return { meta };
}

function handlePut(c: Context, account: Account, info: PathInfo, body: string) {
  if (info.kind !== "event") return c.body(null, 409);
  if (!info.file.endsWith(".ics") || info.file.includes("/")) return c.body("event file must end with .ics", 400);
  const { meta, error } = requireCalendar(c, account, info, true);
  if (error || !meta) return error;
  if (!body.includes("BEGIN:VCALENDAR") || !firstUid(body)) {
    return xml(c, davError("<C:valid-calendar-data/>", "VCALENDAR with UID required"), 403);
  }
  const existing = getEvent(meta, info.file);
  if (!checkPreconditions(c, existing?.etag ?? null)) return c.body(null, 412);
  // One resource per UID per calendar (RFC 4791 5.3.2.1 no-uid-conflict).
  // The organizer writing their own invitation into an attendee's
  // calendar (legacy direct-write offer path) replaces the
  // server-delivered copy instead of sitting next to it.
  const uid = firstUid(body) as string;
  const sameUid = eventsWithUid(meta, uid).filter((ev) => ev.file !== info.file);
  if (sameUid.length > 0) {
    if (!isOrganizerDirectWrite(account, meta, body)) {
      return xml(c, davError("<C:no-uid-conflict/>", `UID already used by ${sameUid[0].file}`), 403);
    }
    for (const ev of sameUid) deleteEvent(meta, ev.file);
  }
  const stored = putEvent(meta, info.file, body);
  onEventPut(account, meta, info.file, existing?.content ?? null, body);
  return c.body(null, existing ? 204 : 201, { ETag: stored.etag, DAV: DAV_HEADER });
}

function handleGet(c: Context, account: Account, info: PathInfo, headOnly: boolean) {
  if (info.kind === "wellknown") return c.redirect("/dav/cal/", 307);
  if (info.kind !== "event") return c.body(null, info.kind === "unknown" ? 404 : 405);
  const { meta, error } = requireCalendar(c, account, info, false);
  if (error || !meta) return error;
  const ev = getEvent(meta, info.file);
  if (!ev) return c.body(null, 404);
  const headers = { "Content-Type": "text/calendar; charset=utf-8", ETag: ev.etag, DAV: DAV_HEADER };
  return headOnly ? c.body(null, 200, headers) : c.body(ev.content, 200, headers);
}

function handleDelete(c: Context, account: Account, info: PathInfo) {
  if (info.kind === "calendar") {
    const meta = getCalendar(info.user, info.calId);
    if (!meta) return c.body(null, 404);
    if (meta.owner !== account.username) return xml(c, davError("<D:need-privileges/>"), 403);
    deleteCalendar(info.user, info.calId);
    return c.body(null, 204);
  }
  if (info.kind !== "event") return c.body(null, 404);
  const { meta, error } = requireCalendar(c, account, info, true);
  if (error || !meta) return error;
  const ev = getEvent(meta, info.file);
  if (!ev) return c.body(null, 404);
  if (!checkPreconditions(c, ev.etag)) return c.body(null, 412);
  deleteEvent(meta, info.file);
  onEventDelete(account, meta, info.file, ev.content);
  return c.body(null, 204);
}

function handleMove(c: Context, account: Account, info: PathInfo) {
  if (info.kind !== "event") return c.body(null, 400);
  const destHeader = c.req.header("Destination");
  if (!destHeader) return c.body("Destination required", 400);
  let destPath: string;
  try {
    destPath = new URL(destHeader).pathname;
  } catch {
    destPath = destHeader;
  }
  const dest = parsePath(destPath);
  if (dest.kind !== "event") return c.body("invalid Destination", 400);
  const src = requireCalendar(c, account, info, true);
  if (src.error || !src.meta) return src.error;
  const dst = requireCalendar(c, account, dest, true);
  if (dst.error || !dst.meta) return dst.error;
  const ev = getEvent(src.meta, info.file);
  if (!ev) return c.body(null, 404);
  const existing = getEvent(dst.meta, dest.file);
  const overwrite = (c.req.header("Overwrite") ?? "T").toUpperCase() !== "F";
  if (existing && !overwrite) return c.body(null, 412);
  putEvent(dst.meta, dest.file, ev.content);
  deleteEvent(src.meta, info.file);
  return c.body(null, existing ? 204 : 201);
}

// --- REPORT ---------------------------------------------------------------

// Uninterpretable recurrence rules surface here, one countable log line
// per diagnostic, instead of being silently approximated away.
function logDiagnostics(where: string, diagnostics: RecurrenceDiagnostic[]): void {
  for (const d of diagnostics) {
    console.warn(`[caldav-hono] recurrence diagnostic (${where}) uid=${d.uid ?? "?"}: ${d.message}`);
  }
}

function handleReport(c: Context, account: Account, info: PathInfo, body: string) {
  if (info.kind !== "calendar") return c.body(null, 400);
  const { meta, error } = requireCalendar(c, account, info, false);
  if (error || !meta) return error;
  const kind = reportKind(body);
  const withData = wantsCalendarData(body);
  if (kind === "calendar-query") {
    const { start, end } = timeRange(body);
    const rs = start ? parseICalDate(start) : null;
    const re = end ? parseICalDate(end) : null;
    const ex = expandRange(body);
    const exs = ex?.start ? parseICalDate(ex.start) : null;
    const exe = ex?.end ? parseICalDate(ex.end) : null;
    const wantExpand = ex !== null && (exs !== null || exe !== null);
    const responses: DavResponse[] = [];
    for (const ev of listEvents(meta)) {
      let match: boolean;
      let data: string | undefined;
      if (!rs && !re && !wantExpand) {
        match = parseCalendar(ev.content).vevents.length > 0;
      } else {
        // Expand over the union of filter and expand windows: the
        // filter decides inclusion, <C:expand> clips the instances.
        const unionStart = !wantExpand ? rs
          : rs === null || exs === null ? null
          : rs < exs ? rs : exs;
        const unionEnd = !wantExpand ? re
          : re === null || exe === null ? null
          : re > exe ? re : exe;
        const expansion = expandCalendar(ev.content, unionStart, unionEnd);
        logDiagnostics("calendar-query", expansion.diagnostics);
        match = !rs && !re
          ? expansion.occurrences.length > 0
          : expansion.occurrences.some((o) => occurrenceOverlaps(o, rs, re));
        if (match && wantExpand && withData) {
          data = expandToICalendar(ev.content, exs, exe).text;
        }
      }
      if (match) {
        responses.push({ href: eventHref(meta, ev.file), propsXml: eventProps(meta, ev, withData, data) });
      }
    }
    return xml(c, multistatus(responses));
  }
  if (kind === "calendar-multiget") {
    const ex = expandRange(body);
    const exs = ex?.start ? parseICalDate(ex.start) : null;
    const exe = ex?.end ? parseICalDate(ex.end) : null;
    const wantExpand = ex !== null && (exs !== null || exe !== null);
    const responses: DavResponse[] = [];
    for (const href of allHrefTexts(body)) {
      const p = parsePath(new URL(href, "http://local").pathname);
      const ev = p.kind === "event" ? getEvent(meta, p.file) : null;
      if (ev) {
        let data: string | undefined;
        if (wantExpand) {
          const expanded = expandToICalendar(ev.content, exs, exe);
          logDiagnostics("calendar-multiget", expanded.diagnostics);
          data = expanded.text;
        }
        responses.push({ href: eventHref(meta, ev.file), propsXml: eventProps(meta, ev, true, data) });
      } else responses.push({ href, status: 404 });
    }
    return xml(c, multistatus(responses));
  }
  if (kind === "free-busy-query") {
    // Read access was already enforced by requireCalendar above, so a
    // principal without read access gets 403 and no busy data leaks.
    const { start, end } = timeRange(body);
    const rs = start ? parseICalDate(start) : null;
    const re = end ? parseICalDate(end) : null;
    if (!rs || !re || rs >= re) {
      return xml(c, davError("<C:valid-time-range/>", "free-busy-query requires a time-range with start < end"), 400);
    }
    const fb = buildFreeBusy(
      listEvents(meta).map((ev) => ev.content), rs, re,
      `freebusy-${randomUUID()}@caldav-hono`, new Date(),
    );
    logDiagnostics("free-busy-query", fb.diagnostics);
    return c.body(fb.text, 200, {
      "Content-Type": "text/calendar; charset=utf-8",
      DAV: DAV_HEADER,
    });
  }
  if (kind === "sync-collection") {
    const token = (tagText(body, "sync-token") ?? "").trim();
    let responses: DavResponse[];
    if (token === "") {
      responses = listEvents(meta).map((ev) => ({
        href: eventHref(meta, ev.file),
        propsXml: eventProps(meta, ev, withData),
      }));
    } else {
      const since = parseSyncToken(meta, token);
      if (since === null) {
        return xml(c, davError("<D:valid-sync-token/>", "unknown or stale sync-token"), 403);
      }
      responses = [];
      for (const entry of journalSince(meta, since)) {
        if (entry.deleted) {
          responses.push({ href: eventHref(meta, entry.file), status: 404 });
        } else {
          const ev = getEvent(meta, entry.file);
          if (ev) responses.push({ href: eventHref(meta, ev.file), propsXml: eventProps(meta, ev, withData) });
        }
      }
    }
    return xml(c, multistatus(responses, `<D:sync-token>${esc(syncToken(meta))}</D:sync-token>`));
  }
  return xml(c, davError("<D:supported-report/>", `unsupported report: ${kind ?? "unknown"}`), 403);
}

// --- App ------------------------------------------------------------------

export function createApp(): Hono {
  const app = new Hono();
  app.get("/healthz", (c) => c.text("ok\n"));
  // Admin plane: its own credential (admin.ts), mounted before the
  // CalDAV catch-all so principal credentials never reach it.
  app.route("/admin", createAdminApp());
  app.all("*", async (c) => {
    const method = c.req.method.toUpperCase();
    const info = parsePath(new URL(c.req.url).pathname);
    if (method === "OPTIONS") {
      return c.body(null, 204, { DAV: DAV_HEADER, Allow: ALLOW });
    }
    // Discovery redirect works unauthenticated; clients then retry with auth.
    if (info.kind === "wellknown" && (method === "GET" || method === "HEAD")) {
      return c.redirect("/dav/cal/", 307);
    }
    if (loadAccounts().length === 0) {
      return c.text("no accounts configured: run npm run seed\n", 503);
    }
    const authHeader = c.req.header("Authorization");
    const account =
      authenticateBasic(authHeader) ?? (await authenticateBearer(authHeader));
    if (!account) {
      const challenge = oidcEnabled()
        ? 'Basic realm="caldav-hono", Bearer realm="caldav-hono"'
        : 'Basic realm="caldav-hono"';
      return c.body(null, 401, { "WWW-Authenticate": challenge, DAV: DAV_HEADER });
    }
    // Stopped principal: credentials are right, access is not. 403 (not
    // 401) so clients do not re-prompt for a password.
    if (isDisabled(account)) return c.text("principal disabled\n", 403, { DAV: DAV_HEADER });
    const body = method === "GET" || method === "HEAD" ? "" : await c.req.text();
    // Note: PROPFIND returns the full useful prop set regardless of the
    // requested subset. Valid for allprop-style clients; strict prop
    // filtering is a next-stage item (see README).
    switch (method) {
      case "PROPFIND": return handlePropfind(c, account, info, body);
      case "MKCALENDAR": return handleMkcalendar(c, account, info, body);
      case "MKCOL": return handleMkcalendar(c, account, info, body);
      case "PROPPATCH": return handleProppatch(c, account, info, body);
      case "PUT": return handlePut(c, account, info, body);
      case "GET": return handleGet(c, account, info, false);
      case "HEAD": return handleGet(c, account, info, true);
      case "DELETE": return handleDelete(c, account, info);
      case "MOVE": return handleMove(c, account, info);
      case "REPORT": return handleReport(c, account, info, body);
      default: return c.body(null, 405, { Allow: ALLOW, DAV: DAV_HEADER });
    }
  });
  return app;
}
