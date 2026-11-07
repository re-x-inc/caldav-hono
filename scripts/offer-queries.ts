// Part C proof: the two offer-side searches as plain SQL over the SQLite
// store's projection tables.
//   Q1 candidate overlap - occurrences in the driver's calendar that
//      overlap the target slot padded by +/-1h (0 rows = offerable).
//   Q2 unanswered offers - NEEDS-ACTION attendees whose response-due is
//      overdue or within the given horizon.
// Usage:
//   node dist/scripts/offer-queries.js \
//     [--driver drv-001] [--cal default] \
//     [--start 20261110T110000Z] [--end 20261110T120000Z] \
//     [--now 20261107T000000Z] [--due-within-hours 48]
// DB location follows CALDAV_DB / CALDAV_DATA like the server.

import { DatabaseSync } from "node:sqlite";
import { parseICalDate } from "../src/ical.js";
import { sqlitePath } from "../src/store-sqlite.js";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1] ?? "");
}
const driver = args.get("driver") ?? "drv-001";
const cal = args.get("cal") ?? "default";
const start = parseICalDate(args.get("start") ?? "20261110T110000Z");
const end = parseICalDate(args.get("end") ?? "20261110T120000Z");
const now = parseICalDate(args.get("now") ?? "20261107T000000Z") ?? new Date();
const withinH = +(args.get("due-within-hours") ?? "48");
if (!start || !end) throw new Error("--start/--end must be iCalendar UTC date-times");

const HOUR = 3_600_000;
const db = new DatabaseSync(sqlitePath(), { readOnly: true });
console.log(`db: ${sqlitePath()}`);

// Q1: period-overlap against the occurrence projection, padded by 1h on
// both sides (transfer/recovery buffer around an offered run).
const q1 = `
SELECT o.href, o.uid, e.summary,
       datetime(o.dtstart_ms/1000,'unixepoch') AS occ_start_utc,
       datetime(o.dtend_ms/1000,'unixepoch')   AS occ_end_utc
FROM occurrences o JOIN events e ON e.href = o.href
WHERE o.owner = ? AND o.cal_id = ?
  AND o.cancelled = 0 AND o.transparent = 0
  AND o.dtstart_ms < ? AND o.dtend_ms > ?
ORDER BY o.dtstart_ms`;
console.log("\nQ1 candidate overlap (target slot +/-1h):");
console.log(q1.trim());
console.log(`params: driver=${driver} cal=${cal} window=[${new Date(start.getTime() - HOUR).toISOString()}, ${new Date(end.getTime() + HOUR).toISOString()}]`);
const q1Rows = db.prepare(q1).all(driver, cal, end.getTime() + HOUR, start.getTime() - HOUR) as unknown as Record<string, unknown>[];
for (const r of q1Rows) console.log(JSON.stringify(r));
console.log(`Q1 result: ${q1Rows.length} overlapping occurrence(s) -> ${q1Rows.length === 0 ? "OFFERABLE (free)" : "BUSY"}`);

// Q2: unanswered offers near/past their response deadline.
// Masters only: the organizer principal owns the calendar the event sits
// in (attendee copies and inbox messages carry the same attendee rows and
// must not double-count an offer).
const q2 = `
SELECT a.href, a.attendee, a.partstat, a.response_due,
       e.uid, e.summary, e.dtstart
FROM event_attendees a JOIN events e ON e.href = a.href
WHERE a.partstat = 'NEEDS-ACTION'
  AND a.response_due IS NOT NULL
  AND a.response_due <= ?
  AND EXISTS (SELECT 1 FROM principals p
              WHERE 'mailto:' || lower(p.email) = e.organizer
                AND p.username = e.owner)
ORDER BY a.response_due`;
const horizon = new Date(now.getTime() + withinH * HOUR).toISOString();
console.log("\nQ2 unanswered offers (due overdue or within horizon):");
console.log(q2.trim());
console.log(`params: now=${now.toISOString()} horizon=${horizon}`);
const q2Rows = db.prepare(q2).all(horizon) as unknown as Record<string, unknown>[];
for (const r of q2Rows) console.log(JSON.stringify(r));
console.log(`Q2 result: ${q2Rows.length} unanswered offer(s)`);
db.close();
