// Basic verification:
//  1. discovery -> MKCALENDAR -> PUT/GET/DELETE -> calendar-query
//  2. sync-collection: initial token -> add/change/delete diffs
// Plus permission checks (stage calendar read-only for drivers).
// Rerunnable: uses a unique run suffix and cleans up after itself.
// Accounts are stable IDs: ops-001 (business), emp-001 (employee),
// drv-001 (contractor/driver, exercised here).

import { BASE, dav, ics, reportCalendarQuery, reportSyncCollection, syncTokenOf } from "./lib.js";

const OPS = "ops-001";
const EMP = "emp-001";
const DRV = "drv-001";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const run = Date.now().toString(36);
const cal = `verify-${run}`;
const calPath = `/calendars/${DRV}/${cal}/`;

const health = await fetch(`${BASE}/healthz`);
check("healthz", health.status === 200, `http=${health.status}`);

// --- discovery --------------------------------------------------------------
const wk = await dav(DRV, "GET", "/.well-known/caldav");
check("well-known redirect", wk.status === 307 && (wk.location ?? "").includes("/dav/cal"), `http=${wk.status} loc=${wk.location}`);

const root = await dav(DRV, "PROPFIND", "/dav/cal/", {
  body: '<D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>',
});
check("current-user-principal", root.status === 207 && root.body.includes(`/principals/${DRV}/`), `http=${root.status}`);

const principal = await dav(DRV, "PROPFIND", `/principals/${DRV}/`, {
  body: '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><C:calendar-home-set/></D:prop></D:propfind>',
});
check("calendar-home-set", principal.status === 207 && principal.body.includes(`/calendars/${DRV}/`), `http=${principal.status}`);

const home = await dav(DRV, "PROPFIND", `/calendars/${DRV}/`, {
  headers: { Depth: "1" },
  body: '<D:propfind xmlns:D="DAV:"><D:prop><D:displayname/><D:resourcetype/></D:prop></D:propfind>',
});
check("home lists own default", home.body.includes(`/calendars/${DRV}/default/`), `http=${home.status}`);
check("home lists shared stage calendar", home.body.includes(`/calendars/${OPS}/stage-booked/`));
check("home shows stage displayname+color", home.body.includes("予約済み") && home.body.includes("#0b8043"));

const unauth = await fetch(`${BASE}/dav/cal/`, { method: "PROPFIND" });
check("unauthenticated -> 401", unauth.status === 401, `http=${unauth.status}`);

// --- MKCALENDAR + event CRUD --------------------------------------------------
const mk = await dav(DRV, "MKCALENDAR", calPath, {
  body:
    '<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:IC="http://apple.com/ns/ical/">' +
    "<D:set><D:prop><D:displayname>検証カレンダー</D:displayname><IC:calendar-color>#123456</IC:calendar-color></D:prop></D:set></C:mkcalendar>",
});
check("MKCALENDAR 201", mk.status === 201, `http=${mk.status}`);

const evPath = `${calPath}verify-ev1-${run}.ics`;
const evBody = ics({ uid: `verify-ev1-${run}@caldav-hono`, start: "20261108T110000Z", end: "20261108T120000Z", summary: "検証予定1" });
const put1 = await dav(DRV, "PUT", evPath, { body: evBody });
check("PUT create 201 + ETag", put1.status === 201 && !!put1.etag, `http=${put1.status} etag=${put1.etag}`);

const get1 = await dav(DRV, "GET", evPath);
check("GET round-trip", get1.status === 200 && get1.body.includes(`verify-ev1-${run}`) && get1.etag === put1.etag, `http=${get1.status}`);

const putBadMatch = await dav(DRV, "PUT", evPath, {
  body: evBody.replace("検証予定1", "検証予定1-更新"),
  headers: { "If-Match": '"deadbeef"' },
});
check("PUT stale If-Match -> 412", putBadMatch.status === 412, `http=${putBadMatch.status}`);

const put2 = await dav(DRV, "PUT", evPath, {
  body: evBody.replace("検証予定1", "検証予定1-更新"),
  headers: { "If-Match": put1.etag ?? "" },
});
check("PUT If-Match update 204 + new ETag", put2.status === 204 && !!put2.etag && put2.etag !== put1.etag, `http=${put2.status}`);

const queryHit = await dav(DRV, "REPORT", calPath, { body: reportCalendarQuery("20261108T000000Z", "20261109T000000Z") });
check("calendar-query time-range hit", queryHit.status === 207 && queryHit.body.includes("検証予定1-更新"), `http=${queryHit.status}`);

const queryMiss = await dav(DRV, "REPORT", calPath, { body: reportCalendarQuery("20261201T000000Z", "20261202T000000Z") });
check("calendar-query time-range miss", queryMiss.status === 207 && !queryMiss.body.includes("検証予定1-更新"), `http=${queryMiss.status}`);

// --- permissions --------------------------------------------------------------
const stageWrite = await dav(DRV, "PUT", `/calendars/${OPS}/stage-booked/nope-${run}.ics`, { body: evBody });
check("driver write to stage calendar -> 403", stageWrite.status === 403, `http=${stageWrite.status}`);

const stageRead = await dav(DRV, "PROPFIND", `/calendars/${OPS}/stage-booked/`, { body: "<D:propfind xmlns:D=\"DAV:\"><D:allprop/></D:propfind>" });
check("driver read stage calendar 207", stageRead.status === 207, `http=${stageRead.status}`);

const empHomeByDrv = await dav(DRV, "PROPFIND", `/calendars/${EMP}/`, { headers: { Depth: "1" }, body: "" });
check("other user's home -> 403", empHomeByDrv.status === 403, `http=${empHomeByDrv.status}`);

// --- sync-collection ------------------------------------------------------------
const sync0 = await dav(DRV, "REPORT", calPath, { body: reportSyncCollection("") });
const token0 = syncTokenOf(sync0.body);
check("sync initial returns member + token", sync0.status === 207 && sync0.body.includes(`verify-ev1-${run}.ics`) && token0 !== "", `http=${sync0.status} token=${token0}`);

const ev2Path = `${calPath}verify-ev2-${run}.ics`;
await dav(DRV, "PUT", ev2Path, { body: ics({ uid: `verify-ev2-${run}@caldav-hono`, start: "20261108T130000Z", end: "20261108T140000Z", summary: "検証予定2" }) });
await dav(DRV, "PUT", evPath, { body: evBody.replace("検証予定1", "検証予定1-再更新"), headers: { "If-Match": put2.etag ?? "" } });

const sync1 = await dav(DRV, "REPORT", calPath, { body: reportSyncCollection(token0) });
const token1 = syncTokenOf(sync1.body);
check("sync diff: added ev2", sync1.body.includes(`verify-ev2-${run}.ics`));
check("sync diff: changed ev1 with etag", sync1.body.includes(`verify-ev1-${run}.ics`) && sync1.body.includes("getetag"));
check("sync token advanced", token1 !== "" && token1 !== token0, `token=${token1}`);

const del = await dav(DRV, "DELETE", ev2Path);
check("DELETE 204", del.status === 204, `http=${del.status}`);

const sync2 = await dav(DRV, "REPORT", calPath, { body: reportSyncCollection(token1) });
check("sync diff: deleted ev2 as 404", sync2.body.includes(`verify-ev2-${run}.ics`) && sync2.body.includes("404"));

const badToken = await dav(DRV, "REPORT", calPath, { body: reportSyncCollection(`urn:caldav-hono:sync:${DRV}:nope:1`) });
check("sync invalid token -> 403", badToken.status === 403, `http=${badToken.status}`);

// --- cleanup ---------------------------------------------------------------------
await dav(DRV, "DELETE", evPath);
const delCal = await dav(DRV, "DELETE", calPath);
check("cleanup: delete calendar 204", delCal.status === 204, `http=${delCal.status}`);

console.log(failures === 0 ? "VERIFY: ALL PASS" : `VERIFY: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
