// Recurrence expansion verification (order 2026-11-07):
//  - calendar-query time-range matches expanded occurrences, not DTSTART
//  - <C:expand> returns only in-range instances
//  - EXDATE / RECURRENCE-ID (incl. RANGE=THISANDFUTURE) semantics
//  - COUNT / UNTIL boundaries, TZID=Asia/Tokyo vs UTC equivalence
//  - free-busy-query includes recurrence instances, permission-gated
// Rerunnable: unique run suffix, cleans up its calendars.
// Server is expected at CALDAV_BASE (same pattern as scripts/verify.ts).

import {
  dav, reportCalendarQuery, reportCalendarQueryExpand, reportFreeBusy,
} from "./lib.js";
import { expandCalendar } from "../src/recurrence.js";

const OPS = "ops-001";
const EMP = "emp-001";
const DRV = "drv-001";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const run = Date.now().toString(36);
const calPath = `/calendars/${DRV}/recur-${run}/`;
const fbCalPath = `/calendars/${DRV}/recur-fb-${run}/`;

function vcal(...events: string[][]): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//caldav-hono//verify-recurrence//EN"];
  for (const ev of events) lines.push("BEGIN:VEVENT", ...ev, "END:VEVENT");
  lines.push("END:VCALENDAR", "");
  return lines.join("\r\n");
}

const STAMP = "DTSTAMP:20261106T000000Z";

// Weekly Mon 01:00-02:00Z, 4 times from 2026-11-02 (Nov 2/9/16/23).
const weeklyFile = `weekly-${run}.ics`;
const weeklyIcs = vcal([
  `UID:weekly-${run}@caldav-hono`, STAMP,
  "DTSTART:20261102T010000Z", "DTEND:20261102T020000Z",
  "RRULE:FREQ=WEEKLY;COUNT=4", "SUMMARY:週次定例",
]);

// Daily 01:00-02:00Z from Nov 10, 5 times, Nov 12 excluded.
const exdateFile = `exdate-${run}.ics`;
const exdateIcs = vcal([
  `UID:exdate-${run}@caldav-hono`, STAMP,
  "DTSTART:20261110T010000Z", "DTEND:20261110T020000Z",
  "RRULE:FREQ=DAILY;COUNT=5", "EXDATE:20261112T010000Z", "SUMMARY:日次（除外あり）",
]);

// Weekly COUNT=3; the Nov 9 instance is moved 01:00 -> 05:00 by override.
const overrideFile = `override-${run}.ics`;
const overrideIcs = vcal(
  [
    `UID:override-${run}@caldav-hono`, STAMP,
    "DTSTART:20261102T010000Z", "DTEND:20261102T020000Z",
    "RRULE:FREQ=WEEKLY;COUNT=3", "SUMMARY:例外あり定例",
  ],
  [
    `UID:override-${run}@caldav-hono`, STAMP,
    "RECURRENCE-ID:20261109T010000Z",
    "DTSTART:20261109T050000Z", "DTEND:20261109T060000Z",
    "SUMMARY:例外あり定例（時刻変更）",
  ],
);

// Weekly COUNT=4; from Nov 16 on, shifted +2h via RANGE=THISANDFUTURE.
const futureFile = `future-${run}.ics`;
const futureIcs = vcal(
  [
    `UID:future-${run}@caldav-hono`, STAMP,
    "DTSTART:20261102T010000Z", "DTEND:20261102T020000Z",
    "RRULE:FREQ=WEEKLY;COUNT=4", "SUMMARY:途中から変更",
  ],
  [
    `UID:future-${run}@caldav-hono`, STAMP,
    "RECURRENCE-ID;RANGE=THISANDFUTURE:20261116T010000Z",
    "DTSTART:20261116T030000Z", "DTEND:20261116T040000Z",
    "SUMMARY:途中から変更（以降）",
  ],
);

// COUNT boundary: daily COUNT=3 from Nov 20 -> last is Nov 22.
const countFile = `count-${run}.ics`;
const countIcs = vcal([
  `UID:count-${run}@caldav-hono`, STAMP,
  "DTSTART:20261120T010000Z", "DTEND:20261120T020000Z",
  "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:COUNT境界",
]);

// UNTIL boundary: daily until Nov 22 01:00Z inclusive.
const untilFile = `until-${run}.ics`;
const untilIcs = vcal([
  `UID:until-${run}@caldav-hono`, STAMP,
  "DTSTART:20261120T010000Z", "DTEND:20261120T020000Z",
  "RRULE:FREQ=DAILY;UNTIL=20261122T010000Z", "SUMMARY:UNTIL境界",
]);

// Same wall rule in Asia/Tokyo (10:00 JST = 01:00Z), with a VTIMEZONE.
const tokyoFile = `tokyo-${run}.ics`;
const tokyoIcs = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//caldav-hono//verify-recurrence//EN",
  "BEGIN:VTIMEZONE", "TZID:Asia/Tokyo",
  "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:+0900", "TZOFFSETTO:+0900", "TZNAME:JST", "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  `UID:tokyo-${run}@caldav-hono`, STAMP,
  "DTSTART;TZID=Asia/Tokyo:20261102T100000", "DTEND;TZID=Asia/Tokyo:20261102T110000",
  "RRULE:FREQ=WEEKLY;COUNT=3", "SUMMARY:東京定例",
  "END:VEVENT", "END:VCALENDAR", "",
].join("\r\n");

// Free-busy fixtures: weekly busy 01:00-02:00Z + transparent block on Nov 9.
const fbWeeklyIcs = vcal([
  `UID:fb-weekly-${run}@caldav-hono`, STAMP,
  "DTSTART:20261102T010000Z", "DTEND:20261102T020000Z",
  "RRULE:FREQ=WEEKLY;COUNT=3", "SUMMARY:FB週次",
]);
const fbTransparentIcs = vcal([
  `UID:fb-transparent-${run}@caldav-hono`, STAMP,
  "DTSTART:20261109T030000Z", "DTEND:20261109T040000Z",
  "TRANSP:TRANSPARENT", "SUMMARY:FB透明",
]);

// --- engine unit checks (no server) ------------------------------------------
function startsOf(text: string, rs: string, re: string): string[] {
  return expandCalendar(text, new Date(rs), new Date(re)).occurrences
    .map((o) => o.start.toISOString());
}

check("unit MONTHLY BYDAY=2MO",
  JSON.stringify(startsOf(vcal([
    "UID:unit-monthly@caldav-hono", STAMP,
    "DTSTART:20261109T010000Z", "DTEND:20261109T020000Z",
    "RRULE:FREQ=MONTHLY;BYDAY=2MO;COUNT=3", "SUMMARY:u",
  ]), "2026-11-01T00:00:00Z", "2027-02-01T00:00:00Z")) ===
  JSON.stringify(["2026-11-09T01:00:00.000Z", "2026-12-14T01:00:00.000Z", "2027-01-11T01:00:00.000Z"]));

check("unit YEARLY leap day",
  JSON.stringify(startsOf(vcal([
    "UID:unit-yearly@caldav-hono", STAMP,
    "DTSTART:20280229T010000Z", "DTEND:20280229T020000Z",
    "RRULE:FREQ=YEARLY;COUNT=2", "SUMMARY:u",
  ]), "2028-01-01T00:00:00Z", "2033-01-01T00:00:00Z")) ===
  JSON.stringify(["2028-02-29T01:00:00.000Z", "2032-02-29T01:00:00.000Z"]));

const rdateText = vcal([
  "UID:unit-rdate@caldav-hono", STAMP,
  "DTSTART:20261102T010000Z", "DTEND:20261102T020000Z",
  "RDATE:20261105T010000Z", "SUMMARY:u",
]);
check("unit RDATE adds an instance",
  startsOf(rdateText, "2026-11-05T00:00:00Z", "2026-11-06T00:00:00Z").length === 1 &&
  startsOf(rdateText, "2026-11-03T00:00:00Z", "2026-11-04T00:00:00Z").length === 0);

check("unit TZID America/New_York across DST end (wall 09:00 stays)",
  JSON.stringify(startsOf(vcal([
    "UID:unit-dst@caldav-hono", STAMP,
    "DTSTART;TZID=America/New_York:20261025T090000", "DTEND;TZID=America/New_York:20261025T100000",
    "RRULE:FREQ=WEEKLY;COUNT=3", "SUMMARY:u",
  ]), "2026-10-24T00:00:00Z", "2026-11-10T00:00:00Z")) ===
  JSON.stringify(["2026-10-25T13:00:00.000Z", "2026-11-01T14:00:00.000Z", "2026-11-08T14:00:00.000Z"]));

const allDay = expandCalendar(vcal([
  "UID:unit-allday@caldav-hono", STAMP,
  "DTSTART;VALUE=DATE:20261102", "DTEND;VALUE=DATE:20261103",
  "RRULE:FREQ=WEEKLY;COUNT=2", "SUMMARY:u",
]), new Date("2026-11-09T00:00:00Z"), new Date("2026-11-10T00:00:00Z"));
check("unit all-day weekly (DATE, exclusive DTEND)",
  allDay.occurrences.length === 1 &&
  allDay.occurrences[0].start.toISOString() === "2026-11-09T00:00:00.000Z" &&
  allDay.occurrences[0].end.toISOString() === "2026-11-10T00:00:00.000Z");

check("unit UNTIL in DATE form includes the UNTIL date",
  startsOf(vcal([
    "UID:unit-until-date@caldav-hono", STAMP,
    "DTSTART;VALUE=DATE:20261120", "DTEND;VALUE=DATE:20261121",
    "RRULE:FREQ=DAILY;UNTIL=20261122", "SUMMARY:u",
  ]), "2026-11-19T00:00:00Z", "2026-11-25T00:00:00Z").length === 3);

const bogus = expandCalendar(vcal([
  "UID:unit-bogus@caldav-hono", STAMP,
  "DTSTART:20261102T010000Z", "DTEND:20261102T020000Z",
  "RRULE:FREQ=NONSENSE", "SUMMARY:u",
]), new Date("2027-01-01T00:00:00Z"), new Date("2027-02-01T00:00:00Z"));
check("unit unsupported RRULE -> diagnostic + approximate fallback (not silent)",
  bogus.diagnostics.some((d) => d.message.includes("unsupported RRULE")) &&
  bogus.occurrences.length === 1 && bogus.occurrences[0].approximate === true,
  bogus.diagnostics.map((d) => d.message).join(" | ").slice(0, 120));

async function mkcal(path: string): Promise<number> {
  const r = await dav(DRV, "MKCALENDAR", path, {
    body:
      '<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
      "<D:set><D:prop><D:displayname>繰り返し検証</D:displayname></D:prop></D:set></C:mkcalendar>",
  });
  return r.status;
}

const mk1 = await mkcal(calPath);
const mk2 = await mkcal(fbCalPath);
check("MKCALENDAR x2", mk1 === 201 && mk2 === 201, `http=${mk1}/${mk2}`);

const puts = await Promise.all([
  dav(DRV, "PUT", calPath + weeklyFile, { body: weeklyIcs }),
  dav(DRV, "PUT", calPath + exdateFile, { body: exdateIcs }),
  dav(DRV, "PUT", calPath + overrideFile, { body: overrideIcs }),
  dav(DRV, "PUT", calPath + futureFile, { body: futureIcs }),
  dav(DRV, "PUT", calPath + countFile, { body: countIcs }),
  dav(DRV, "PUT", calPath + untilFile, { body: untilIcs }),
  dav(DRV, "PUT", calPath + tokyoFile, { body: tokyoIcs }),
  dav(DRV, "PUT", fbCalPath + `fb-weekly-${run}.ics`, { body: fbWeeklyIcs }),
  dav(DRV, "PUT", fbCalPath + `fb-transparent-${run}.ics`, { body: fbTransparentIcs }),
]);
check("fixtures PUT 201", puts.every((p) => p.status === 201), puts.map((p) => p.status).join(","));

// --- weekly: occurrence-level time-range ------------------------------------
const hitNov9 = await dav(DRV, "REPORT", calPath, { body: reportCalendarQuery("20261109T000000Z", "20261110T000000Z") });
check("weekly: Nov 9 range hits", hitNov9.body.includes(weeklyFile), `http=${hitNov9.status}`);

const missNov3 = await dav(DRV, "REPORT", calPath, { body: reportCalendarQuery("20261103T000000Z", "20261104T000000Z") });
check("weekly: Nov 3 range (no occurrence) misses", !missNov3.body.includes(weeklyFile), `http=${missNov3.status}`);

const expandNov = await dav(DRV, "REPORT", calPath, {
  body: reportCalendarQueryExpand("20261108T000000Z", "20261117T000000Z", "20261108T000000Z", "20261117T000000Z"),
});
check("weekly expand: only Nov 9+16 instances of weekly", expandNov.body.includes("DTSTART:20261109T010000Z") && expandNov.body.includes("DTSTART:20261116T010000Z") && !expandNov.body.includes("DTSTART:20261102T010000Z") && !expandNov.body.includes("DTSTART:20261123T010000Z"), `http=${expandNov.status}`);

// --- EXDATE ------------------------------------------------------------------
const exRange = await dav(DRV, "REPORT", calPath, { body: reportCalendarQuery("20261112T000000Z", "20261113T000000Z") });
check("EXDATE: excluded Nov 12 misses", !exRange.body.includes(exdateFile), `http=${exRange.status}`);

const exExpand = await dav(DRV, "REPORT", calPath, {
  body: reportCalendarQueryExpand("20261110T000000Z", "20261115T000000Z", "20261110T000000Z", "20261115T000000Z"),
});
check("EXDATE expand: Nov 12 absent, 10/11/13/14 present",
  !exExpand.body.includes("DTSTART:20261112T010000Z") &&
  exExpand.body.includes("DTSTART:20261110T010000Z") && exExpand.body.includes("DTSTART:20261114T010000Z"));

// --- RECURRENCE-ID override ----------------------------------------------------
const origSlot = await dav(DRV, "REPORT", calPath, { body: reportCalendarQuery("20261109T000000Z", "20261109T030000Z") });
check("override: original Nov 9 01:00 slot misses", !origSlot.body.includes(overrideFile), `http=${origSlot.status}`);

const movedSlot = await dav(DRV, "REPORT", calPath, { body: reportCalendarQuery("20261109T040000Z", "20261109T070000Z") });
check("override: moved Nov 9 05:00 slot hits", movedSlot.body.includes(overrideFile), `http=${movedSlot.status}`);

const ovExpand = await dav(DRV, "REPORT", calPath, {
  body: reportCalendarQueryExpand("20261109T000000Z", "20261110T000000Z", "20261109T000000Z", "20261110T000000Z"),
});
check("override expand: shows 05:00 + override summary, RECURRENCE-ID kept",
  ovExpand.body.includes("DTSTART:20261109T050000Z") &&
  ovExpand.body.includes("例外あり定例（時刻変更）") &&
  ovExpand.body.includes("RECURRENCE-ID:20261109T010000Z"));

// --- RANGE=THISANDFUTURE --------------------------------------------------------
const futBefore = await dav(DRV, "REPORT", calPath, { body: reportCalendarQuery("20261123T000000Z", "20261123T023000Z") });
check("THISANDFUTURE: Nov 23 pre-shift slot misses", !futBefore.body.includes(futureFile), `http=${futBefore.status}`);

const futAfter = await dav(DRV, "REPORT", calPath, { body: reportCalendarQuery("20261123T023000Z", "20261123T043000Z") });
check("THISANDFUTURE: Nov 23 shifted 03:00 slot hits", futAfter.body.includes(futureFile), `http=${futAfter.status}`);

const futEarly = await dav(DRV, "REPORT", calPath, { body: reportCalendarQuery("20261109T003000Z", "20261109T023000Z") });
check("THISANDFUTURE: Nov 9 (before split) still 01:00", futEarly.body.includes(futureFile), `http=${futEarly.status}`);

// --- COUNT / UNTIL boundaries -----------------------------------------------------
const countLast = await dav(DRV, "REPORT", calPath, { body: reportCalendarQuery("20261122T000000Z", "20261123T000000Z") });
check("COUNT: last occurrence Nov 22 hits", countLast.body.includes(countFile));
const countPast = await dav(DRV, "REPORT", calPath, { body: reportCalendarQuery("20261123T000000Z", "20261124T000000Z") });
check("COUNT: Nov 23 (past COUNT) misses", !countPast.body.includes(countFile));

const untilLast = await dav(DRV, "REPORT", calPath, { body: reportCalendarQuery("20261122T000000Z", "20261123T000000Z") });
check("UNTIL: occurrence == UNTIL (Nov 22) included", untilLast.body.includes(untilFile));
const untilPast = await dav(DRV, "REPORT", calPath, { body: reportCalendarQuery("20261123T000000Z", "20261124T000000Z") });
check("UNTIL: Nov 23 (past UNTIL) misses", !untilPast.body.includes(untilFile));

// --- TZID=Asia/Tokyo vs UTC ---------------------------------------------------------
const tzHit = await dav(DRV, "REPORT", calPath, { body: reportCalendarQuery("20261109T003000Z", "20261109T013000Z") });
check("TZID: Tokyo 10:00 JST hits 00:30-01:30Z window", tzHit.body.includes(tokyoFile) && tzHit.body.includes(weeklyFile));
const tzMiss = await dav(DRV, "REPORT", calPath, { body: reportCalendarQuery("20261109T020000Z", "20261109T030000Z") });
check("TZID: Tokyo occurrence absent at 02:00-03:00Z", !tzMiss.body.includes(tokyoFile) && !tzMiss.body.includes(weeklyFile));

const tzExpand = await dav(DRV, "REPORT", calPath, {
  body: reportCalendarQueryExpand("20261109T000000Z", "20261110T000000Z", "20261109T000000Z", "20261110T000000Z"),
});
check("TZID expand: wall time 10:00 kept with TZID param",
  tzExpand.body.includes("DTSTART;TZID=Asia/Tokyo:20261109T100000"));

// --- multiget expand / no-time-range query (regression guards) --------------------------
const mg = await dav(DRV, "REPORT", calPath, {
  body:
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
    '<D:prop><D:getetag/><C:calendar-data><C:expand start="20261109T000000Z" end="20261110T000000Z"/></C:calendar-data></D:prop>' +
    `<D:href>${calPath}${weeklyFile}</D:href></C:calendar-multiget>`,
});
check("multiget expand: only the Nov 9 instance",
  mg.body.includes("DTSTART:20261109T010000Z") && !mg.body.includes("DTSTART:20261116T010000Z"), `http=${mg.status}`);

const noRange = await dav(DRV, "REPORT", calPath, {
  body:
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
    "<D:prop><D:getetag/></D:prop>" +
    '<C:filter><C:comp-filter name="VCALENDAR"/></C:filter></C:calendar-query>',
});
check("calendar-query without time-range still returns resources", noRange.body.includes(weeklyFile), `http=${noRange.status}`);

// --- free-busy-query ------------------------------------------------------------------
const fb = await dav(DRV, "REPORT", fbCalPath, { body: reportFreeBusy("20261109T000000Z", "20261110T000000Z") });
check("free-busy: 200 + VFREEBUSY", fb.status === 200 && fb.body.includes("BEGIN:VFREEBUSY"), `http=${fb.status}`);
check("free-busy: weekly instance busy 01:00-02:00Z on Nov 9", fb.body.includes("20261109T010000Z/20261109T020000Z"));
check("free-busy: TRANSPARENT block not busy", !fb.body.includes("20261109T030000Z/20261109T040000Z"));

const fbDenied = await dav(EMP, "REPORT", fbCalPath, { body: reportFreeBusy("20261109T000000Z", "20261110T000000Z") });
check("free-busy: no-access principal -> 403", fbDenied.status === 403, `http=${fbDenied.status}`);

const fbStage = await dav(DRV, "REPORT", `/calendars/${OPS}/stage-booked/`, { body: reportFreeBusy("20261108T000000Z", "20261109T000000Z") });
check("free-busy: reader of stage calendar gets VFREEBUSY", fbStage.status === 200 && fbStage.body.includes("BEGIN:VFREEBUSY"), `http=${fbStage.status}`);

// --- cleanup ----------------------------------------------------------------------------
for (const f of [weeklyFile, exdateFile, overrideFile, futureFile, countFile, untilFile, tokyoFile]) {
  await dav(DRV, "DELETE", calPath + f);
}
await dav(DRV, "DELETE", fbCalPath + `fb-weekly-${run}.ics`);
await dav(DRV, "DELETE", fbCalPath + `fb-transparent-${run}.ics`);
const del1 = await dav(DRV, "DELETE", calPath);
const del2 = await dav(DRV, "DELETE", fbCalPath);
check("cleanup: delete calendars 204", del1.status === 204 && del2.status === 204, `http=${del1.status}/${del2.status}`);

console.log(failures === 0 ? "VERIFY-RECURRENCE: ALL PASS" : `VERIFY-RECURRENCE: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

