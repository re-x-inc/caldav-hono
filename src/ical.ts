// Minimal iCalendar (RFC 5545) syntax layer: unfolding, property/component
// parsing, and date formatting. Recurrence *semantics* (expansion) live in
// recurrence.ts; this module only turns text into components and back.

export function unfold(text: string): string[] {
  const raw = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const lines: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else if (line.length > 0) {
      lines.push(line);
    }
  }
  return lines;
}

// Fold a content line to at most 75 octets per physical line (RFC 5545 3.1).
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let rest = bytes;
  let limit = 75;
  while (rest.length > limit) {
    let cut = limit;
    while (cut > 0 && (rest[cut] & 0xc0) === 0x80) cut -= 1; // keep UTF-8 whole
    parts.push(rest.subarray(0, cut).toString("utf8"));
    rest = rest.subarray(cut);
    limit = 74; // continuation lines carry a leading space
  }
  parts.push(rest.toString("utf8"));
  return parts.join("\r\n ");
}

export function joinICalendar(lines: string[]): string {
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

// Parses 20261107, 20261107T110000Z, 20261107T200000 (floating) as UTC.
// Used for CalDAV time-range attributes, which are always UTC date-times.
export function parseICalDate(value: string): Date | null {
  const v = value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?Z?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0"] = m;
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  return Number.isNaN(ms) ? null : new Date(ms);
}

export function parseDurationMs(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const days = (+(m[2] ?? 0)) * 7 + +(m[3] ?? 0);
  const ms = (((days * 24 + +(m[4] ?? 0)) * 60 + +(m[5] ?? 0)) * 60 + +(m[6] ?? 0)) * 1000;
  return sign * ms;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

// Format a pseudo-UTC millisecond value (wall-clock fields read as UTC).
export function formatWallMs(wallMs: number, dateOnly: boolean): string {
  const d = new Date(wallMs);
  const date = `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
  if (dateOnly) return date;
  return `${date}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`;
}

export function formatUtc(date: Date): string {
  return formatWallMs(date.getTime(), false) + "Z";
}

export interface ICalProp {
  name: string; // upper-case property name
  params: Record<string, string>; // upper-case param name -> unquoted value
  value: string;
  line: string; // original unfolded line
}

export interface ICalComponent {
  name: string; // e.g. VEVENT
  props: ICalProp[];
  children: ICalComponent[];
  lines: string[]; // unfolded lines of this component, BEGIN..END inclusive
}

// Split on a separator that appears outside double quotes.
function splitQuoted(s: string, sep: string): string[] {
  const out: string[] = [];
  let inQuote = false;
  let cur = "";
  for (const ch of s) {
    if (ch === '"') inQuote = !inQuote;
    if (ch === sep && !inQuote) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function parsePropLine(line: string): ICalProp | null {
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ":" && !inQuote) { colon = i; break; }
  }
  if (colon < 0) return null;
  const head = splitQuoted(line.slice(0, colon), ";");
  const params: Record<string, string> = {};
  for (const p of head.slice(1)) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const v = p.slice(eq + 1);
    params[p.slice(0, eq).trim().toUpperCase()] = v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
  }
  return {
    name: head[0].trim().toUpperCase(),
    params,
    value: line.slice(colon + 1),
    line,
  };
}

export interface ParsedCalendar {
  calendarProps: ICalProp[]; // direct properties of VCALENDAR
  vevents: ICalComponent[];
  vtimezones: ICalComponent[];
}

export function parseCalendar(text: string): ParsedCalendar {
  const out: ParsedCalendar = { calendarProps: [], vevents: [], vtimezones: [] };
  const stack: ICalComponent[] = [];
  for (const line of unfold(text)) {
    const upper = line.toUpperCase();
    if (upper.startsWith("BEGIN:")) {
      for (const open of stack) open.lines.push(line);
      const comp: ICalComponent = { name: line.slice(6).trim().toUpperCase(), props: [], children: [], lines: [line] };
      if (stack.length > 0) stack[stack.length - 1].children.push(comp);
      stack.push(comp);
      continue;
    }
    if (upper.startsWith("END:")) {
      const comp = stack.pop();
      if (comp) {
        comp.lines.push(line);
        for (const open of stack) open.lines.push(line);
        if (stack.length === 1 && stack[0].name === "VCALENDAR") {
          if (comp.name === "VEVENT") out.vevents.push(comp);
          else if (comp.name === "VTIMEZONE") out.vtimezones.push(comp);
        }
      }
      continue;
    }
    // Append the line to every open component's raw lines so nested
    // components (e.g. VALARM inside VEVENT) stay part of the parent text.
    for (const open of stack) open.lines.push(line);
    const prop = parsePropLine(line);
    if (!prop || stack.length === 0) continue;
    const top = stack[stack.length - 1];
    top.props.push(prop);
    if (top.name === "VCALENDAR") out.calendarProps.push(prop);
  }
  return out;
}

export function propOf(comp: ICalComponent, name: string): ICalProp | undefined {
  return comp.props.find((p) => p.name === name);
}

export function propsOf(comp: ICalComponent, name: string): ICalProp[] {
  return comp.props.filter((p) => p.name === name);
}

// --- scheduling-oriented views and text surgery (RFC 5546/6638) -----------

// Calendar-user addresses compare case-insensitively; keep the mailto:
// scheme so values round-trip into ATTENDEE/ORGANIZER lines unchanged.
export function normAddr(value: string): string {
  return value.trim().toLowerCase();
}

export interface AttendeeInfo {
  address: string; // normalized (lower-case, mailto: kept)
  partstat: string; // upper-case, NEEDS-ACTION when absent
  scheduleAgent: string; // upper-case, SERVER when absent
  responseDue: string | null; // ISO 8601 from X-RESPONSE-DUE param/prop
}

// The master component of a resource: first VEVENT without RECURRENCE-ID
// (occurrence-level scheduling is out of scope; see scheduling note).
export function masterEvent(text: string): ICalComponent | undefined {
  const { vevents } = parseCalendar(text);
  return vevents.find((v) => !propOf(v, "RECURRENCE-ID")) ?? vevents[0];
}

export function organizerAddress(text: string): string | null {
  const master = masterEvent(text);
  const org = master ? propOf(master, "ORGANIZER") : undefined;
  return org ? normAddr(org.value) : null;
}

function dueToIso(raw: string | undefined): string | null {
  if (!raw) return null;
  const d = parseICalDate(raw);
  return d ? d.toISOString() : null;
}

export function attendeesOf(text: string): AttendeeInfo[] {
  const master = masterEvent(text);
  if (!master) return [];
  const eventDue = dueToIso(propOf(master, "X-RESPONSE-DUE")?.value);
  return propsOf(master, "ATTENDEE").map((p) => ({
    address: normAddr(p.value),
    partstat: (p.params.PARTSTAT ?? "NEEDS-ACTION").trim().toUpperCase(),
    scheduleAgent: (p.params["SCHEDULE-AGENT"] ?? "SERVER").trim().toUpperCase(),
    responseDue: dueToIso(p.params["X-RESPONSE-DUE"]) ?? eventDue,
  }));
}

function lineHeadOf(prop: ICalProp): string {
  return prop.line.slice(0, prop.line.length - prop.value.length - 1);
}

// Group unfolded lines into VCALENDAR-level blocks so surgery can skip
// RECURRENCE-ID override components. Returns the lines of each top-level
// component plus the calendar header/footer lines around them.
function setPartstatInLines(lines: string[], address: string, partstat: string): string[] {
  return lines.map((line) => {
    const prop = parsePropLine(line);
    if (!prop || prop.name !== "ATTENDEE" || normAddr(prop.value) !== address) return line;
    const head = lineHeadOf(prop);
    const newHead = /;PARTSTAT=[^;:]*/i.test(head)
      ? head.replace(/;PARTSTAT=[^;:]*/i, `;PARTSTAT=${partstat}`)
      : `${head};PARTSTAT=${partstat}`;
    return `${newHead}:${prop.value}`;
  });
}

// Rewrite one attendee's PARTSTAT on master (non-override) components.
export function setAttendeePartstat(text: string, address: string, partstat: string): string {
  const addr = normAddr(address);
  const out: string[] = [];
  let block: string[] | null = null;
  const flush = () => {
    if (!block) return;
    const isOverride = block.some((l) => l.toUpperCase().startsWith("RECURRENCE-ID"));
    out.push(...(isOverride ? block : setPartstatInLines(block, addr, partstat)));
    block = null;
  };
  for (const line of unfold(text)) {
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VEVENT") { flush(); block = [line]; continue; }
    if (upper === "END:VEVENT" && block) { block.push(line); flush(); continue; }
    if (block) block.push(line); else out.push(line);
  }
  flush();
  return joinICalendar(out);
}

// Insert or replace the VCALENDAR METHOD (iTIP message framing).
export function withMethod(text: string, method: string): string {
  const lines = unfold(text);
  const idx = lines.findIndex((l) => l.toUpperCase().startsWith("METHOD:"));
  if (idx >= 0) lines[idx] = `METHOD:${method}`;
  else {
    const at = lines.findIndex((l) => l.toUpperCase().startsWith("BEGIN:VEVENT"));
    lines.splice(at < 0 ? lines.length - 1 : at, 0, `METHOD:${method}`);
  }
  return joinICalendar(lines);
}

// DTSTAMP = when this iTIP message was produced (RFC 5546 1.3): rewrite
// it on every VEVENT of a delivered inbox message so retention can be
// judged from the message itself.
export function restamp(text: string, when: Date): string {
  const stamp = `DTSTAMP:${formatUtc(when)}`;
  const lines = unfold(text);
  const out: string[] = [];
  let inEvent = false;
  let stamped = false;
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VEVENT") { inEvent = true; stamped = false; out.push(line); continue; }
    if (upper === "END:VEVENT") {
      if (inEvent && !stamped) out.push(stamp);
      inEvent = false;
      out.push(line);
      continue;
    }
    if (inEvent && upper.startsWith("DTSTAMP")) {
      if (!stamped) { out.push(stamp); stamped = true; }
      continue;
    }
    out.push(line);
  }
  return joinICalendar(out);
}

export function dtstampOf(text: string): Date | null {
  const master = masterEvent(text);
  const raw = master ? propOf(master, "DTSTAMP")?.value : undefined;
  return raw ? parseICalDate(raw) : null;
}

export function stripMethod(text: string): string {
  return joinICalendar(unfold(text).filter((l) => !l.toUpperCase().startsWith("METHOD:")));
}

// STATUS:CANCELLED on the master component (for METHOD:CANCEL copies).
export function markCancelled(text: string): string {
  const lines = unfold(text);
  const begin = lines.findIndex((l) => l.toUpperCase() === "BEGIN:VEVENT");
  if (begin < 0) return text;
  let end = lines.findIndex((l, i) => i > begin && l.toUpperCase() === "END:VEVENT");
  if (end < 0) end = lines.length;
  const statusIdx = lines.findIndex((l, i) => i > begin && i < end && l.toUpperCase().startsWith("STATUS:"));
  if (statusIdx >= 0) lines[statusIdx] = "STATUS:CANCELLED";
  else lines.splice(end, 0, "STATUS:CANCELLED");
  return joinICalendar(lines);
}

// Minimal iTIP REPLY: same UID, the replying attendee only (RFC 5546 3.2.3).
export function buildReplyCalendar(sourceText: string, attendeeAddress: string, partstat: string): string {
  const master = masterEvent(sourceText);
  const addr = normAddr(attendeeAddress);
  const pick = (name: string) => (master ? propOf(master, name)?.line : undefined);
  const attendeeLine = master
    ? propsOf(master, "ATTENDEE").find((p) => normAddr(p.value) === addr)?.line
    : undefined;
  const replyAttendee = attendeeLine
    ? setPartstatInLines([attendeeLine], addr, partstat)[0]
    : `ATTENDEE;PARTSTAT=${partstat}:${attendeeAddress}`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//caldav-hono//scheduling//EN",
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    pick("UID") ?? "UID:unknown@caldav-hono",
    `DTSTAMP:${formatUtc(new Date())}`,
    ...(pick("DTSTART") ? [pick("DTSTART") as string] : []),
    ...(pick("DTEND") ? [pick("DTEND") as string] : []),
    ...(pick("SUMMARY") ? [pick("SUMMARY") as string] : []),
    ...(pick("ORGANIZER") ? [pick("ORGANIZER") as string] : []),
    replyAttendee,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return joinICalendar(lines);
}

export function firstUid(text: string): string | null {
  for (const line of unfold(text)) {
    if (line.toUpperCase().startsWith("UID")) {
      const colon = line.indexOf(":");
      if (colon >= 0) return line.slice(colon + 1).trim();
    }
  }
  return null;
}

