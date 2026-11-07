// Offer flow replay (direct-write form).
//  1. operator (ops-001) checks drv-001 availability around the target slot
//  2. operator puts the reservation into stage-request and directly into
//     drv-001's default calendar with PARTSTAT=NEEDS-ACTION (= offer)
//  3. drv-001 GETs it, rewrites PARTSTAT=ACCEPTED with If-Match PUT
//  4. operator detects ACCEPTED (via sync-collection diff + GET) and
//     moves the stage-request copy to stage-booked (MOVE)
// Target slot: 2026-11-08 20:00-21:00 JST = 11:00-12:00 UTC.
// Leaves the final state in place:
// drv-001 default has the ACCEPTED offer, stage-booked has the reservation.

import { BASE, dav, ics, reportCalendarQuery, reportSyncCollection, syncTokenOf } from "./lib.js";

const OPS = "ops-001";
const DRV = "drv-001";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const file = "offer-resv-20261108.ics";
const uid = "offer-resv-20261108@caldav-hono";
const drvPath = `/calendars/${DRV}/default/${file}`;
const stageReqPath = `/calendars/${OPS}/stage-request/${file}`;
const stageBookedPath = `/calendars/${OPS}/stage-booked/${file}`;

// Idempotent start: remove residue from a previous run.
await dav(OPS, "DELETE", stageBookedPath);
await dav(OPS, "DELETE", stageReqPath);
await dav(DRV, "DELETE", drvPath);

// 1. availability check (ops-001 may read drv-001/avail; collision check on
//    default is done through the sync token baseline below).
const avail = await dav(OPS, "REPORT", `/calendars/${DRV}/avail/`, {
  body: reportCalendarQuery("20261108T110000Z", "20261108T120000Z"),
});
check("drv-001 availability covers target slot", avail.status === 207 && avail.body.includes("受けられる時間"), `http=${avail.status}`);

const baseSync = await dav(OPS, "REPORT", `/calendars/${DRV}/default/`, { body: reportSyncCollection("") });
const baseToken = syncTokenOf(baseSync.body);
check("operator baseline sync-token on drv-001/default", baseToken !== "", `token=${baseToken}`);

// 2. offer: stage-request master + direct write into drv-001 default (NEEDS-ACTION).
const offerBody = ics({
  uid, start: "20261108T110000Z", end: "20261108T120000Z",
  summary: "予約（オファー再演）：横浜駅→自宅", attendeePartstat: "NEEDS-ACTION",
});
const stagePut = await dav(OPS, "PUT", stageReqPath, { body: offerBody });
check("stage-request PUT", stagePut.status === 201, `http=${stagePut.status}`);

const offerPut = await dav(OPS, "PUT", drvPath, { body: offerBody });
check("operator direct PUT into drv-001/default (NEEDS-ACTION)", offerPut.status === 201, `http=${offerPut.status}`);

// 3. drv-001 accepts with If-Match.
const seen = await dav(DRV, "GET", drvPath);
check("drv-001 sees offer NEEDS-ACTION", seen.status === 200 && seen.body.includes("PARTSTAT=NEEDS-ACTION"), `http=${seen.status} etag=${seen.etag}`);

const accept = await dav(DRV, "PUT", drvPath, {
  body: seen.body.replace("PARTSTAT=NEEDS-ACTION", "PARTSTAT=ACCEPTED"),
  headers: { "If-Match": seen.etag ?? "" },
});
check("drv-001 ACCEPTED PUT with If-Match 204", accept.status === 204, `http=${accept.status}`);

// 4. operator detects via sync diff, confirms ACCEPTED, moves stage.
const diff = await dav(OPS, "REPORT", `/calendars/${DRV}/default/`, { body: reportSyncCollection(baseToken) });
check("operator sync diff includes offer file", diff.body.includes(file));

const master = await dav(OPS, "GET", drvPath);
check("operator reads ACCEPTED", master.status === 200 && master.body.includes("PARTSTAT=ACCEPTED"), `http=${master.status}`);

const move = await dav(OPS, "MOVE", stageReqPath, {
  headers: { Destination: `${BASE}${stageBookedPath}` },
});
check("stage move request->booked (MOVE)", move.status === 201 || move.status === 204, `http=${move.status}`);

const reqNow = await dav(OPS, "REPORT", `/calendars/${OPS}/stage-request/`, { body: reportCalendarQuery("20261108T000000Z", "20261109T000000Z") });
check("stage-request no longer has the reservation", !reqNow.body.includes(uid));

const bookedNow = await dav(OPS, "REPORT", `/calendars/${OPS}/stage-booked/`, { body: reportCalendarQuery("20261108T000000Z", "20261109T000000Z") });
check("stage-booked has the reservation", bookedNow.body.includes(uid));

console.log(failures === 0 ? "OFFER-FLOW: ALL PASS" : `OFFER-FLOW: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
