// One-shot migration: file store (CALDAV_DATA/calendars/**) -> SQLite
// (CALDAV_DB or CALDAV_DATA/caldav.sqlite). Idempotent; calendars already
// in the DB are skipped. After importing, cross-checks that every .ics
// file on disk has a matching events row. Exits nonzero on mismatch.

import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../src/store.js";
import { closeSqlite, migrateFileStoreToSqlite, sqlitePath } from "../src/store-sqlite.js";

const result = migrateFileStoreToSqlite();
console.log(`db: ${sqlitePath()}`);
console.log(`imported: ${result.calendars} calendars, ${result.events} events (skipped ${result.skipped} existing)`);

let fileEvents = 0;
const base = join(dataDir(), "calendars");
if (existsSync(base)) {
  for (const owner of readdirSync(base)) {
    for (const cal of readdirSync(join(base, owner))) {
      const evDir = join(base, owner, cal, "events");
      if (existsSync(evDir)) fileEvents += readdirSync(evDir).filter((f) => f.endsWith(".ics")).length;
    }
  }
}
closeSqlite();
const ro = new DatabaseSync(sqlitePath(), { readOnly: true });
const dbEvents = (ro.prepare("SELECT COUNT(*) AS n FROM events").get() as unknown as { n: number }).n;
const dbCals = (ro.prepare("SELECT COUNT(*) AS n FROM calendars").get() as unknown as { n: number }).n;
const dbOcc = (ro.prepare("SELECT COUNT(*) AS n FROM occurrences").get() as unknown as { n: number }).n;
ro.close();
console.log(`check: file .ics=${fileEvents} db events=${dbEvents} calendars=${dbCals} occurrences=${dbOcc}`);
if (fileEvents !== dbEvents) {
  console.error("MISMATCH: file and DB event counts differ");
  process.exit(1);
}
console.log("MIGRATE: OK");
