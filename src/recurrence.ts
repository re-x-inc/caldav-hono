// Recurrence expansion engine (RFC 5545 subset), read-side only.
//
// The store keeps one .ics file per resource; expansion happens here, on
// the read path, so a future DB projection can reuse expandCalendar()
// as its generator without touching REPORT handling.
//
// RRULE evaluation is delegated to the `rrule` package (BSD-3-Clause),
// hidden behind generateWalls(): nothing outside this module imports it,
// so the library stays swappable. Expansion runs in the DTSTART
// wall-clock frame (wall fields read as pseudo-UTC) and each generated
// wall time is converted to a real instant through the IANA time zone
// (Intl), which keeps wall times stable across DST transitions.
//
// Supported subset (expo-caldav design §4.3): one or more RRULE with
// FREQ=DAILY/WEEKLY/MONTHLY/YEARLY (plus the other frequencies and BY*
// parts rrule implements), INTERVAL, COUNT, UNTIL, RDATE (DATE,
// DATE-TIME, PERIOD), EXDATE, RECURRENCE-ID overrides incl.
// RANGE=THISANDFUTURE, DATE / UTC / floating / TZID date-times.
// Rules the engine cannot interpret are never silently dropped: they
// produce a RecurrenceDiagnostic and the series falls back to the old
// DTSTART approximation (occurrence flagged `approximate`).

import { createRequire } from "node:module";
import type { RRule as RRuleClass } from "rrule";
import {
  formatUtc, formatWallMs, joinICalendar, parseCalendar, parseDurationMs,
  parsePropLine, propOf, propsOf,
  type ICalComponent, type ICalProp, type ParsedCalendar,
} from "./ical.js";

// rrule's ESM build uses extensionless imports Node cannot load, and its
// CJS entry exposes no statically detectable named exports, so load it
// through createRequire and type it from its own declarations.
const { RRule } = createRequire(import.meta.url)("rrule") as {
  RRule: typeof RRuleClass;
};

export interface RecurrenceDiagnostic {
  uid: string | null;
  message: string;
}

export interface Occurrence {
  uid: string;
  start: Date;
  end: Date;
  // Full "RECURRENCE-ID..." line identifying the generated instance this
  // occurrence stands for; null for a non-recurring single event.
  recurrenceIdLine: string | null;
  source: ICalComponent; // component to copy properties from when expanding
  transparent: boolean;
  cancelled: boolean;
  // True when the recurrence rule could not be interpreted and this
  // occurrence stands for the whole series from DTSTART on (coarse
  // approximation). Always accompanied by a diagnostic.
  approximate?: boolean;
}

export interface Expansion {
  occurrences: Occurrence[];
  diagnostics: RecurrenceDiagnostic[];
}

const MAX_ITERATIONS = 100_000; // RRULE steps scanned per rule
const MAX_OCCURRENCES = 10_000; // occurrences kept per resource
const HORIZON_MS = 3660 * 86_400_000; // ~10y when the query has no end

// --- time zones --------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function tzFormatter(tz: string): Intl.DateTimeFormat | null {
  let f = formatters.get(tz);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
    } catch {
      f = null;
    }
    formatters.set(tz, f);
  }
  return f;
}

// Wall-clock fields of an instant in tz, as pseudo-UTC milliseconds.
function utcToWallMs(tz: string, utcMs: number): number {
  const f = tzFormatter(tz);
  if (!f) return utcMs;
  const parts: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(utcMs))) {
    if (p.type !== "literal") parts[p.type] = +p.value;
  }
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
}

function wallToUtcMs(tz: string, wallMs: number): number {
  // Fixed-point iteration on the zone offset; converges in <=2 rounds
  // except inside DST gaps/overlaps, where it settles on a side.
  let utc = wallMs;
  for (let i = 0; i < 3; i += 1) {
    const next = wallMs - (utcToWallMs(tz, utc) - utc);
    if (next === utc) break;
    utc = next;
  }
  return utc;
}

// --- date-time values ----------------------------------------------------------

interface ParsedDT {
  raw: string;
  isDate: boolean;
  utc: boolean; // value ended in Z
  tzid: string | null; // validated IANA name, else null
  hasValueParam: boolean; // VALUE=DATE/DATE-TIME was explicit
  wallMs: number; // wall fields as pseudo-UTC ms
  instantMs: number; // real instant
}

function parseDTValue(
  value: string, params: Record<string, string>,
  uid: string | null, diagnostics: RecurrenceDiagnostic[],
): ParsedDT | null {
  const raw = value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z)?$/.exec(raw);
  if (!m) {
    diagnostics.push({ uid, message: `unparseable date-time value "${raw}"` });
    return null;
  }
  const isDate = m[4] === undefined;
  const wallMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  let tzid: string | null = null;
  const tzParam = params.TZID;
  if (tzParam && !isDate) {
    if (tzFormatter(tzParam)) tzid = tzParam;
    else diagnostics.push({ uid, message: `unknown TZID "${tzParam}"; treating wall time as UTC` });
  }
  return {
    raw, isDate, utc: m[7] === "Z", tzid,
    hasValueParam: params.VALUE !== undefined,
    wallMs,
    instantMs: tzid ? wallToUtcMs(tzid, wallMs) : wallMs,
  };
}

function parseDTProp(
  prop: ICalProp | undefined, uid: string | null,
  diagnostics: RecurrenceDiagnostic[],
): ParsedDT | null {
  if (!prop) return null;
  return parseDTValue(prop.value, prop.params, uid, diagnostics);
}

// Wall time of an instant expressed in a template's frame.
function wallInFrame(template: ParsedDT, instantMs: number): number {
  return template.tzid ? utcToWallMs(template.tzid, instantMs) : instantMs;
}

function instantInFrame(template: ParsedDT, wallMs: number): number {
  return template.tzid ? wallToUtcMs(template.tzid, wallMs) : wallMs;
}

// Format an instant the way the template (e.g. master DTSTART) is written.
function formatLike(template: ParsedDT, instantMs: number): string {
  if (template.isDate) return formatWallMs(wallInFrame(template, instantMs), true);
  if (template.utc && !template.tzid) return formatUtc(new Date(instantMs));
  return formatWallMs(wallInFrame(template, instantMs), false);
}

function recurrenceIdLine(template: ParsedDT, instantMs: number): string {
  const params =
    (template.tzid ? `;TZID=${template.tzid}` : "") +
    (template.isDate && template.hasValueParam ? ";VALUE=DATE" : "");
  return `RECURRENCE-ID${params}:${formatLike(template, instantMs)}`;
}

function sameFrame(a: ParsedDT, b: ParsedDT): boolean {
  return a.tzid === b.tzid && a.isDate === b.isDate;
}

// --- component spans -----------------------------------------------------------

interface Span {
  start: ParsedDT;
  endMs: number;
  durationMs: number;
}

function componentSpan(
  comp: ICalComponent, uid: string | null,
  diagnostics: RecurrenceDiagnostic[],
): Span | null {
  const start = parseDTProp(propOf(comp, "DTSTART"), uid, diagnostics);
  if (!start) {
    diagnostics.push({ uid, message: "VEVENT without a parseable DTSTART; skipped" });
    return null;
  }
  const dtend = parseDTProp(propOf(comp, "DTEND"), uid, diagnostics);
  let endMs: number;
  if (dtend) {
    endMs = dtend.instantMs;
  } else {
    const durProp = propOf(comp, "DURATION");
    const dur = durProp ? parseDurationMs(durProp.value) : null;
    endMs = start.instantMs + (dur ?? (start.isDate ? 86_400_000 : 0));
  }
  return { start, endMs, durationMs: Math.max(0, endMs - start.instantMs) };
}

function isCancelled(comp: ICalComponent): boolean {
  return propOf(comp, "STATUS")?.value.trim().toUpperCase() === "CANCELLED";
}

function isTransparent(comp: ICalComponent): boolean {
  return propOf(comp, "TRANSP")?.value.trim().toUpperCase() === "TRANSPARENT";
}

// --- RRULE generation (the only place the rrule library is touched) -----------

// Generate occurrence wall times (in dtstart's frame) between the given
// wall bounds. UNTIL is stripped before handing the rule to rrule and
// applied here, because rrule compares UNTIL in the pseudo-UTC frame
// while the RFC compares real instants (they differ across DST).
function generateWalls(
  rruleValue: string, dtstart: ParsedDT,
  genStartWall: number, genEndWall: number,
  uid: string | null, diagnostics: RecurrenceDiagnostic[],
): { walls: number[]; ok: boolean } {
  let until: ParsedDT | null = null;
  const kept: string[] = [];
  for (const part of rruleValue.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim().toUpperCase() === "UNTIL") {
      until = parseDTValue(part.slice(eq + 1), {}, uid, diagnostics);
    } else if (part.trim() !== "") {
      kept.push(part);
    }
  }
  let rule: InstanceType<typeof RRuleClass>;
  try {
    rule = RRule.fromString(
      `DTSTART:${formatWallMs(dtstart.wallMs, false)}Z\nRRULE:${kept.join(";")}`,
    );
  } catch (e) {
    diagnostics.push({
      uid,
      message: `unsupported RRULE "${rruleValue}": ${e instanceof Error ? e.message : String(e)}`,
    });
    return { walls: [], ok: false };
  }
  let capped = false;
  const all = rule.all((d, i) => {
    if (i >= MAX_ITERATIONS) { capped = true; return false; }
    return d.getTime() <= genEndWall;
  });
  if (capped) {
    diagnostics.push({ uid, message: `RRULE "${rruleValue}": iteration cap (${MAX_ITERATIONS}) reached; later occurrences not scanned` });
  }
  const untilInstant = until && !until.isDate
    ? (!until.utc && dtstart.tzid ? wallToUtcMs(dtstart.tzid, until.wallMs) : until.instantMs)
    : null;
  const walls = all
    .map((d) => d.getTime())
    .filter((w) => w >= genStartWall)
    .filter((w) => {
      if (!until) return true;
      if (until.isDate) return Math.floor(w / 86_400_000) <= Math.floor(until.wallMs / 86_400_000);
      return instantInFrame(dtstart, w) <= (untilInstant ?? until.instantMs);
    });
  return { walls, ok: true };
}

// --- working occurrences ---------------------------------------------------------

interface WorkingOcc {
  idWallMs: number; // identity (original instance) in master frame
  idInstantMs: number;
  startMs: number; // actual start instant
  endMs: number;
  source: ICalComponent;
  ridLine: string | null;
  approximate?: boolean;
}

function parseDTList(
  prop: ICalProp, uid: string | null,
  diagnostics: RecurrenceDiagnostic[],
): ParsedDT[] {
  const out: ParsedDT[] = [];
  for (const item of prop.value.split(",")) {
    if (item.trim() === "") continue;
    const parsed = parseDTValue(item, prop.params, uid, diagnostics);
    if (parsed) out.push(parsed);
  }
  return out;
}

// Instances of one component standing alone: RRULE/EXRULE/RDATE/EXDATE
// applied, overrides not yet. Bounds are instants; converted per frame.
function baseInstances(
  comp: ICalComponent, span: Span, uid: string,
  genStartMs: number, genEndMs: number,
  diagnostics: RecurrenceDiagnostic[],
): { occs: WorkingOcc[]; ok: boolean; recurring: boolean } {
  const template = span.start;
  const genStartWall = wallInFrame(template, genStartMs);
  const genEndWall = wallInFrame(template, genEndMs);
  const rrules = propsOf(comp, "RRULE");
  const rdates = propsOf(comp, "RDATE");
  const recurring = rrules.length > 0 || rdates.length > 0;
  if (!recurring) {
    return {
      occs: [{
        idWallMs: template.wallMs, idInstantMs: template.instantMs,
        startMs: template.instantMs, endMs: span.endMs,
        source: comp, ridLine: null,
      }],
      ok: true, recurring: false,
    };
  }
  let ok = true;
  const walls = new Set<number>();
  for (const rr of rrules) {
    const gen = generateWalls(rr.value, template, genStartWall, genEndWall, uid, diagnostics);
    if (!gen.ok) ok = false;
    for (const w of gen.walls) walls.add(w);
  }
  for (const ex of propsOf(comp, "EXRULE")) {
    const gen = generateWalls(ex.value, template, genStartWall, genEndWall, uid, diagnostics);
    if (!gen.ok) ok = false;
    for (const w of gen.walls) walls.delete(w);
  }
  const occs: WorkingOcc[] = [...walls].map((w) => {
    const instant = instantInFrame(template, w);
    return {
      idWallMs: w, idInstantMs: instant,
      startMs: instant, endMs: instant + span.durationMs,
      source: comp, ridLine: recurrenceIdLine(template, instant),
    };
  });
  for (const rd of rdates) {
    for (const item of rd.value.split(",")) {
      const trimmed = item.trim();
      if (trimmed === "") continue;
      if (trimmed.includes("/")) {
        // RDATE;VALUE=PERIOD:start/end or start/duration
        const [a, b] = trimmed.split("/");
        const start = parseDTValue(a, rd.params, uid, diagnostics);
        if (!start) continue;
        const dur = parseDurationMs(b);
        const endParsed = dur === null ? parseDTValue(b, rd.params, uid, diagnostics) : null;
        const endMs = dur !== null ? start.instantMs + dur : (endParsed?.instantMs ?? start.instantMs + span.durationMs);
        occs.push({
          idWallMs: wallInFrame(template, start.instantMs), idInstantMs: start.instantMs,
          startMs: start.instantMs, endMs,
          source: comp, ridLine: recurrenceIdLine(template, start.instantMs),
        });
      } else {
        const start = parseDTValue(trimmed, rd.params, uid, diagnostics);
        if (!start) continue;
        occs.push({
          idWallMs: wallInFrame(template, start.instantMs), idInstantMs: start.instantMs,
          startMs: start.instantMs, endMs: start.instantMs + span.durationMs,
          source: comp, ridLine: recurrenceIdLine(template, start.instantMs),
        });
      }
    }
  }
  // EXDATE removes instances from the whole generated set.
  const exInstants = new Set<number>();
  const exWalls = new Set<number>();
  for (const ex of propsOf(comp, "EXDATE")) {
    for (const parsed of parseDTList(ex, uid, diagnostics)) {
      exInstants.add(parsed.instantMs);
      if (sameFrame(parsed, template)) exWalls.add(parsed.wallMs);
    }
  }
  const kept = occs.filter((o) => !exInstants.has(o.idInstantMs) && !exWalls.has(o.idWallMs));
  return { occs: kept, ok, recurring: true };
}

// --- overrides -------------------------------------------------------------------

interface OverrideRec {
  comp: ICalComponent;
  rid: ParsedDT;
  thisAndFuture: boolean;
  span: Span | null;
}

function ridMatches(rid: ParsedDT, occ: WorkingOcc, masterTemplate: ParsedDT): boolean {
  if (occ.idInstantMs === rid.instantMs) return true;
  return sameFrame(rid, masterTemplate) && occ.idWallMs === rid.wallMs;
}

function expandGroup(
  uid: string, comps: ICalComponent[],
  rangeStart: Date | null, rangeEnd: Date | null,
  diagnostics: RecurrenceDiagnostic[],
): WorkingOcc[] {
  const masters = comps.filter((c) => !propOf(c, "RECURRENCE-ID"));
  const overrideComps = comps.filter((c) => propOf(c, "RECURRENCE-ID"));
  const overrides: OverrideRec[] = [];
  for (const comp of overrideComps) {
    const ridProp = propOf(comp, "RECURRENCE-ID");
    const rid = ridProp ? parseDTProp(ridProp, uid, diagnostics) : null;
    if (!rid) continue;
    overrides.push({
      comp, rid,
      thisAndFuture: ridProp?.params.RANGE?.toUpperCase() === "THISANDFUTURE",
      span: componentSpan(comp, uid, diagnostics),
    });
  }
  if (masters.length === 0) {
    diagnostics.push({ uid, message: "RECURRENCE-ID components without a master; treating each as a single event" });
    return overrides.flatMap((ov) => ov.span ? [{
      idWallMs: ov.rid.wallMs, idInstantMs: ov.rid.instantMs,
      startMs: ov.span.start.instantMs, endMs: ov.span.endMs,
      source: ov.comp, ridLine: recurrenceIdLine(ov.rid, ov.rid.instantMs),
    }] : []);
  }
  if (masters.length > 1) {
    diagnostics.push({ uid, message: `multiple master components for one UID (${masters.length}); expanding each` });
  }
  const master = masters[0];
  const masterSpan = componentSpan(master, uid, diagnostics);
  if (!masterSpan) return [];
  const template = masterSpan.start;

  const maxDuration = Math.max(
    masterSpan.durationMs,
    ...overrides.map((o) => o.span?.durationMs ?? 0),
  );
  const maxShift = Math.max(0, ...overrides
    .filter((o) => o.thisAndFuture && o.span)
    .map((o) => Math.abs(wallInFrame(template, o.span!.start.instantMs) - wallInFrame(template, o.rid.instantMs))));
  const genStartMs = rangeStart
    ? rangeStart.getTime() - maxDuration - maxShift
    : template.instantMs;
  const genEndMs = rangeEnd
    ? rangeEnd.getTime() + maxShift
    : Math.max(rangeStart?.getTime() ?? 0, template.instantMs) + HORIZON_MS;

  const base = baseInstances(master, masterSpan, uid, genStartMs, genEndMs, diagnostics);
  if (!base.ok) {
    diagnostics.push({ uid, message: "falling back to DTSTART approximation for this series (see RRULE diagnostic above)" });
    return [{
      idWallMs: template.wallMs, idInstantMs: template.instantMs,
      startMs: template.instantMs, endMs: masterSpan.endMs,
      source: master, ridLine: null, approximate: true,
    }];
  }
  let occs = base.occs;
  for (const extra of masters.slice(1)) {
    const span = componentSpan(extra, uid, diagnostics);
    if (span) occs.push(...baseInstances(extra, span, uid, genStartMs, genEndMs, diagnostics).occs);
  }

  // Single-instance overrides: drop the generated instance, add the
  // replacement (unless cancelled). Replacements are added even when
  // the original instance lies outside the generation window, so an
  // instance moved *into* the window is still found.
  const replacements: WorkingOcc[] = [];
  for (const ov of overrides.filter((o) => !o.thisAndFuture)) {
    occs = occs.filter((o) => !ridMatches(ov.rid, o, template));
    if (!isCancelled(ov.comp) && ov.span) {
      replacements.push({
        idWallMs: wallInFrame(template, ov.rid.instantMs), idInstantMs: ov.rid.instantMs,
        startMs: ov.span.start.instantMs, endMs: ov.span.endMs,
        source: ov.comp, ridLine: recurrenceIdLine(template, ov.rid.instantMs),
      });
    }
  }

  // RANGE=THISANDFUTURE, earliest first. An override carrying its own
  // RRULE restarts the series; without one, instances from the
  // RECURRENCE-ID on shift by the override's wall-clock delta and take
  // the override's properties. Shifts re-derive from instance identity,
  // so a later split replaces an earlier shift instead of stacking.
  const tfSorted = overrides
    .filter((o) => o.thisAndFuture)
    .sort((a, b) => wallInFrame(template, a.rid.instantMs) - wallInFrame(template, b.rid.instantMs));
  let splitDone = false;
  for (const ov of tfSorted) {
    const ridWall = wallInFrame(template, ov.rid.instantMs);
    if (splitDone) {
      diagnostics.push({ uid, message: "THISANDFUTURE after a series restart/cancellation; ignoring the later split" });
      continue;
    }
    if (isCancelled(ov.comp)) {
      occs = occs.filter((o) => o.idWallMs < ridWall);
      splitDone = true;
      continue;
    }
    if (!ov.span) continue;
    if (propsOf(ov.comp, "RRULE").length > 0) {
      const sub = baseInstances(ov.comp, ov.span, uid, genStartMs, genEndMs, diagnostics);
      if (sub.ok) {
        occs = [...occs.filter((o) => o.idWallMs < ridWall), ...sub.occs];
        splitDone = true;
        continue;
      }
      diagnostics.push({ uid, message: "THISANDFUTURE with an unsupported RRULE; applying it as a plain shift" });
    }
    const delta = wallInFrame(template, ov.span.start.instantMs) - ridWall;
    const duration = ov.span.durationMs;
    occs = occs.map((o) => {
      if (o.idWallMs < ridWall) return o;
      const startMs = instantInFrame(template, o.idWallMs + delta);
      return { ...o, startMs, endMs: startMs + duration, source: ov.comp };
    });
  }

  const byIdentity = new Map<string, WorkingOcc>();
  for (const occ of [...occs, ...replacements]) {
    byIdentity.set(occ.ridLine ?? `single:${occ.startMs}`, occ);
  }
  return [...byIdentity.values()].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

// --- public expansion ------------------------------------------------------------

export function occurrenceOverlaps(occ: Occurrence, rangeStart: Date | null, rangeEnd: Date | null): boolean {
  if (occ.approximate) return !rangeEnd || occ.start < rangeEnd;
  if (rangeEnd && occ.start >= rangeEnd) return false;
  if (rangeStart && occ.end <= rangeStart) return false;
  return true;
}

function expandParsedCalendar(
  parsed: ParsedCalendar, rangeStart: Date | null, rangeEnd: Date | null,
): Expansion {
  const diagnostics: RecurrenceDiagnostic[] = [];
  const groups = new Map<string, { uid: string; comps: ICalComponent[] }>();
  parsed.vevents.forEach((comp, i) => {
    const uid = propOf(comp, "UID")?.value.trim() || null;
    if (!uid) diagnostics.push({ uid: null, message: "VEVENT without UID; expanding it standalone" });
    const key = uid ?? `__nouid_${i}`;
    const group = groups.get(key) ?? { uid: uid ?? "", comps: [] };
    group.comps.push(comp);
    groups.set(key, group);
  });
  const occurrences: Occurrence[] = [];
  for (const { uid, comps } of groups.values()) {
    for (const w of expandGroup(uid, comps, rangeStart, rangeEnd, diagnostics)) {
      const occ: Occurrence = {
        uid,
        start: new Date(w.startMs),
        end: new Date(w.endMs),
        recurrenceIdLine: w.ridLine,
        source: w.source,
        transparent: isTransparent(w.source),
        cancelled: isCancelled(w.source),
        ...(w.approximate ? { approximate: true } : {}),
      };
      if (occurrenceOverlaps(occ, rangeStart, rangeEnd)) occurrences.push(occ);
    }
  }
  occurrences.sort((a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime());
  if (occurrences.length > MAX_OCCURRENCES) {
    diagnostics.push({ uid: null, message: `occurrence cap (${MAX_OCCURRENCES}) reached; truncating expansion` });
    occurrences.length = MAX_OCCURRENCES;
  }
  return { occurrences, diagnostics };
}

export function expandCalendar(text: string, rangeStart: Date | null, rangeEnd: Date | null): Expansion {
  return expandParsedCalendar(parseCalendar(text), rangeStart, rangeEnd);
}

// --- expanded serialization (CalDAV <C:expand>) --------------------------------

function lineHead(prop: ICalProp): string {
  return prop.line.slice(0, prop.line.length - prop.value.length - 1);
}

function serializeExpanded(parsed: ParsedCalendar, occurrences: Occurrence[]): string {
  const headerNames = new Set(["VERSION", "PRODID", "CALSCALE", "METHOD"]);
  const header = parsed.calendarProps.filter((p) => headerNames.has(p.name)).map((p) => p.line);
  if (!parsed.calendarProps.some((p) => p.name === "VERSION")) header.unshift("VERSION:2.0");
  if (!parsed.calendarProps.some((p) => p.name === "PRODID")) header.push("PRODID:-//caldav-hono//expand//EN");
  const lines: string[] = [
    "BEGIN:VCALENDAR", ...header,
    ...parsed.vtimezones.flatMap((tz) => tz.lines),
  ];
  const compsByUid = new Map<string, ICalComponent[]>();
  for (const comp of parsed.vevents) {
    const uid = propOf(comp, "UID")?.value.trim() ?? "";
    compsByUid.set(uid, [...(compsByUid.get(uid) ?? []), comp]);
  }
  const emittedApprox = new Set<string>();
  const silent: RecurrenceDiagnostic[] = [];
  for (const occ of occurrences) {
    if (occ.approximate) {
      // Uninterpretable series: hand back the original components
      // rather than a guessed expansion (diagnostic already emitted).
      if (!emittedApprox.has(occ.uid)) {
        emittedApprox.add(occ.uid);
        for (const comp of compsByUid.get(occ.uid) ?? []) lines.push(...comp.lines);
      }
      continue;
    }
    const source = occ.source;
    const recurrenceProps = ["RRULE", "EXRULE", "RDATE", "EXDATE"]
      .some((n) => propsOf(source, n).length > 0);
    if (!recurrenceProps && occ.recurrenceIdLine === null) {
      lines.push(...source.lines); // plain single event: verbatim
      continue;
    }
    const startProp = propOf(source, "DTSTART");
    const startTemplate = startProp ? parseDTValue(startProp.value, startProp.params, occ.uid, silent) : null;
    if (!startProp || !startTemplate) {
      lines.push(...source.lines);
      continue;
    }
    const dtendHead = lineHead(startProp).replace(/^DTSTART/i, "DTEND");
    const sourceHasRid = propOf(source, "RECURRENCE-ID") !== undefined;
    const occDuration = occ.end.getTime() - occ.start.getTime();
    for (const line of source.lines) {
      const upper = line.toUpperCase();
      if (upper.startsWith("BEGIN:") || upper.startsWith("END:")) {
        lines.push(line);
        continue;
      }
      const prop = parsePropLine(line);
      if (!prop) {
        lines.push(line);
        continue;
      }
      switch (prop.name) {
        case "RRULE":
        case "EXRULE":
        case "RDATE":
        case "EXDATE":
          break; // recurrence definition is consumed by the expansion
        case "DTSTART":
          lines.push(`${lineHead(prop)}:${formatLike(startTemplate, occ.start.getTime())}`);
          if (occ.recurrenceIdLine && !sourceHasRid) lines.push(occ.recurrenceIdLine);
          break;
        case "DTEND": {
          const endTemplate = parseDTValue(prop.value, prop.params, occ.uid, silent) ?? startTemplate;
          lines.push(`${lineHead(prop)}:${formatLike(endTemplate, occ.end.getTime())}`);
          break;
        }
        case "DURATION":
          if (parseDurationMs(prop.value) === occDuration) lines.push(line);
          else lines.push(`${dtendHead}:${formatLike(startTemplate, occ.end.getTime())}`);
          break;
        case "RECURRENCE-ID":
          if (occ.recurrenceIdLine) lines.push(occ.recurrenceIdLine);
          break;
        default:
          lines.push(line);
      }
    }
  }
  lines.push("END:VCALENDAR");
  return joinICalendar(lines);
}

export interface ExpandedCalendar {
  text: string;
  occurrences: Occurrence[];
  diagnostics: RecurrenceDiagnostic[];
}

export function expandToICalendar(
  text: string, rangeStart: Date | null, rangeEnd: Date | null,
): ExpandedCalendar {
  const parsed = parseCalendar(text);
  const expansion = expandParsedCalendar(parsed, rangeStart, rangeEnd);
  return {
    text: serializeExpanded(parsed, expansion.occurrences),
    occurrences: expansion.occurrences,
    diagnostics: expansion.diagnostics,
  };
}

// --- free-busy (RFC 4791 free-busy-query / RFC 5545 VFREEBUSY) ------------------

export function buildFreeBusy(
  texts: string[], rangeStart: Date, rangeEnd: Date,
  uid: string, dtstamp: Date,
): { text: string; diagnostics: RecurrenceDiagnostic[] } {
  const diagnostics: RecurrenceDiagnostic[] = [];
  const periods: { start: number; end: number }[] = [];
  for (const text of texts) {
    const expansion = expandCalendar(text, rangeStart, rangeEnd);
    diagnostics.push(...expansion.diagnostics);
    for (const occ of expansion.occurrences) {
      if (occ.transparent || occ.cancelled) continue;
      const start = Math.max(occ.start.getTime(), rangeStart.getTime());
      const end = Math.min(occ.end.getTime(), rangeEnd.getTime());
      if (end > start) periods.push({ start, end });
    }
  }
  periods.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: { start: number; end: number }[] = [];
  for (const p of periods) {
    const last = merged[merged.length - 1];
    if (last && p.start <= last.end) last.end = Math.max(last.end, p.end);
    else merged.push({ ...p });
  }
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//caldav-hono//freebusy//EN",
    "BEGIN:VFREEBUSY",
    `UID:${uid}`,
    `DTSTAMP:${formatUtc(dtstamp)}`,
    `DTSTART:${formatUtc(rangeStart)}`,
    `DTEND:${formatUtc(rangeEnd)}`,
    ...(merged.length > 0
      ? [`FREEBUSY;FBTYPE=BUSY:${merged.map((p) => `${formatUtc(new Date(p.start))}/${formatUtc(new Date(p.end))}`).join(",")}`]
      : []),
    "END:VFREEBUSY",
    "END:VCALENDAR",
  ];
  return { text: joinICalendar(lines), diagnostics };
}



