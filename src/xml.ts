// Tiny XML helpers. The server reads only a few well-known elements from
// request bodies, so targeted extraction beats a full parser dependency.

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const NS =
  'xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" ' +
  'xmlns:CS="http://calendarserver.org/ns/" xmlns:IC="http://apple.com/ns/ical/"';

export interface DavResponse {
  href: string;
  propsXml?: string; // inner XML of <D:prop>, wrapped in a 200 propstat
  status?: number; // when set without propsXml: bare status (e.g. 404)
}

export function multistatus(responses: DavResponse[], extraTop = ""): string {
  const body = responses
    .map((r) => {
      const propstat =
        r.propsXml != null
          ? `<D:propstat><D:prop>${r.propsXml}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`
          : `<D:status>HTTP/1.1 ${r.status ?? 200} ${r.status === 404 ? "Not Found" : "OK"}</D:status>`;
      return `<D:response><D:href>${esc(r.href)}</D:href>${propstat}</D:response>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus ${NS}>${body}${extraTop}</D:multistatus>`;
}

export function davError(condition: string, description?: string): string {
  const desc = description ? `<D:error-description>${esc(description)}</D:error-description>` : "";
  return `<?xml version="1.0" encoding="utf-8"?>\n<D:error ${NS}>${condition}${desc}</D:error>`;
}

function localRe(name: string): RegExp {
  return new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${name}>`, "i");
}

export function tagText(xml: string, name: string): string | null {
  const m = localRe(name).exec(xml);
  if (m) return m[1].trim();
  // self-closing form <sync-token/>
  const self = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${name}(?:\\s[^>]*)?/>`, "i").exec(xml);
  return self ? "" : null;
}

export function allHrefTexts(xml: string): string[] {
  const re = /<(?:[A-Za-z0-9_.-]+:)?href(?:\s[^>]*)?>([^<]*)</gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
  return out;
}

export function timeRange(xml: string): { start: string | null; end: string | null } {
  const m = /<(?:[A-Za-z0-9_.-]+:)?time-range\b([^>]*)/i.exec(xml);
  if (!m) return { start: null, end: null };
  const attrs = m[1];
  const pick = (k: string) => new RegExp(`${k}="([^"]*)"`).exec(attrs)?.[1] ?? null;
  return { start: pick("start"), end: pick("end") };
}

// <C:expand start="..." end="..."/> inside <C:calendar-data> (RFC 4791 9.6.5).
export function expandRange(xml: string): { start: string | null; end: string | null } | null {
  const m = /<(?:[A-Za-z0-9_.-]+:)?expand\b([^>]*)/i.exec(xml);
  if (!m) return null;
  const attrs = m[1];
  const pick = (k: string) => new RegExp(`${k}="([^"]*)"`).exec(attrs)?.[1] ?? null;
  return { start: pick("start"), end: pick("end") };
}

export function requestedProps(xml: string): { all: boolean; names: Set<string> } {
  if (/<(?:[A-Za-z0-9_.-]+:)?allprop\b/i.test(xml) || xml.trim() === "") {
    return { all: true, names: new Set() };
  }
  const propBlock = localRe("prop").exec(xml)?.[1] ?? xml;
  const names = new Set<string>();
  const re = /<(?:([A-Za-z0-9_.-]+):)?([A-Za-z0-9_.-]+)[\s/>]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(propBlock)) !== null) names.add(m[2].toLowerCase());
  return { all: names.size === 0, names };
}

export function wantsCalendarData(xml: string): boolean {
  return /<(?:[A-Za-z0-9_.-]+:)?calendar-data\b/i.test(xml);
}

export function reportKind(xml: string): "calendar-query" | "calendar-multiget" | "sync-collection" | "free-busy-query" | null {
  for (const k of ["calendar-query", "calendar-multiget", "sync-collection", "free-busy-query"] as const) {
    if (new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${k}\\b`, "i").test(xml)) return k;
  }
  return null;
}
