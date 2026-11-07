import { readFileSync } from "node:fs";
import { accountsPath } from "../src/auth.js";

export const BASE = process.env.CALDAV_BASE ?? "http://127.0.0.1:5232";

export function passwordOf(username: string): string {
  const parsed = JSON.parse(readFileSync(accountsPath(), "utf8")) as {
    accounts: { username: string; password: string }[];
  };
  const a = parsed.accounts.find((x) => x.username === username);
  if (!a) throw new Error(`account not found: ${username}`);
  return a.password;
}

export interface DavResult {
  status: number;
  body: string;
  etag: string | null;
  location: string | null;
}

export async function dav(
  user: string, method: string, path: string,
  opts: { body?: string; headers?: Record<string, string>; redirect?: RequestRedirect } = {},
): Promise<DavResult> {
  const headers: Record<string, string> = {
    Authorization: "Basic " + Buffer.from(`${user}:${passwordOf(user)}`).toString("base64"),
    ...(opts.body && !opts.headers?.["Content-Type"]
      ? { "Content-Type": method === "PUT" ? "text/calendar; charset=utf-8" : "application/xml; charset=utf-8" }
      : {}),
    ...(opts.headers ?? {}),
  };
  const res = await fetch(BASE + path, {
    method, headers, body: opts.body, redirect: opts.redirect ?? "manual",
  });
  return { status: res.status, body: await res.text(), etag: res.headers.get("etag"), location: res.headers.get("location") };
}

export function ics(fields: {
  uid: string; start: string; end: string; summary: string;
  extra?: string[]; attendeePartstat?: string;
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//caldav-hono//verify//EN",
    "BEGIN:VEVENT",
    `UID:${fields.uid}`,
    "DTSTAMP:20261106T000000Z",
    `DTSTART:${fields.start}`,
    `DTEND:${fields.end}`,
    `SUMMARY:${fields.summary}`,
    ...(fields.attendeePartstat
      ? [`ATTENDEE;CN=Driver;PARTSTAT=${fields.attendeePartstat}:mailto:drv-001@example.test`, "ORGANIZER;CN=Operator:mailto:ops-001@example.test"]
      : []),
    ...(fields.extra ?? []),
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ];
  return lines.join("\r\n");
}

export function reportCalendarQuery(start: string, end: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
    "<D:prop><D:getetag/><C:calendar-data/></D:prop>" +
    '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">' +
    `<C:time-range start="${start}" end="${end}"/>` +
    "</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>"
  );
}

export function reportCalendarQueryExpand(start: string, end: string, expandStart: string, expandEnd: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
    `<D:prop><D:getetag/><C:calendar-data><C:expand start="${expandStart}" end="${expandEnd}"/></C:calendar-data></D:prop>` +
    '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">' +
    `<C:time-range start="${start}" end="${end}"/>` +
    "</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>"
  );
}

export function reportFreeBusy(start: string, end: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<C:free-busy-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
    `<C:time-range start="${start}" end="${end}"/>` +
    "</C:free-busy-query>"
  );
}

export function reportSyncCollection(token: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<D:sync-collection xmlns:D="DAV:">' +
    `<D:sync-token>${token}</D:sync-token>` +
    "<D:sync-level>1</D:sync-level>" +
    "<D:prop><D:getetag/></D:prop></D:sync-collection>"
  );
}

export function syncTokenOf(xml: string): string {
  const m = /<[^:>]*:?sync-token[^>]*>([^<]*)</.exec(xml);
  return m ? m[1].trim() : "";
}
