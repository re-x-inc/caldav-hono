// Admin plane: provisioning principals from the SaaS side. A separate
// HTTP surface under /admin with its own credential, never the CalDAV
// Basic/OIDC principal credentials:
//   - shared secret: CALDAV_ADMIN_TOKEN env or config/admin.local.json
//     {"token": "..."} (CALDAV_ADMIN_CONFIG relocates), sent as
//     Authorization: Bearer <token>
//   - or an OIDC access token whose configured admin claim matches
//     (oidc.ts adminClaim/adminValue)
// With neither configured every /admin request is 503: the plane never
// opens unauthenticated. Requires the SQLite store (principals table);
// the file store answers 501.
//
// JSON API (all responses application/json):
//   GET    /admin/principals
//   POST   /admin/principals            {kind|username, displayName?, email?, oidcSubject?, provision?=true}
//                                       -> 201 {principal, password, provision}
//   GET    /admin/principals/:u
//   PATCH  /admin/principals/:u         {displayName?, email?, oidcSubject?|null}
//   POST   /admin/principals/:u/disable | /enable
//   POST   /admin/principals/:u/password -> {password}   (issue / reset)
//   POST   /admin/principals/:u/provision -> {provision} (initial calendar set, idempotent)
//   DELETE /admin/principals/:u         (principal + owned calendars + grants)
//   GET    /admin/principals/:u/calendars
//   PUT    /admin/calendars/:owner/:cal/acl/:u   {access: "read"|"write"}
//   DELETE /admin/calendars/:owner/:cal/acl/:u
// Passwords are returned once in the response of the call that set them
// and never logged or stored in clear.

import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import { generatePassword, hashPassword, type Account } from "./auth.js";
import { isAdminToken, oidcAdminConfigured, verifyBearer } from "./oidc.js";
import {
  KINDS, USERNAME_RE, allocateUsername, defaultEmail, kindOf, provisionPrincipal,
  type PrincipalKind,
} from "./provision.js";
import { getCalendar, listCalendars, storeBackend, updateCalendar, type CalendarMeta } from "./store.js";
import * as sqlite from "./store-sqlite.js";

export function adminConfigPath(): string {
  return process.env.CALDAV_ADMIN_CONFIG ?? join(process.cwd(), "config", "admin.local.json");
}

// Reloaded per request like the other local config files.
export function adminToken(): string | null {
  const env = process.env.CALDAV_ADMIN_TOKEN;
  if (env && env.trim()) return env.trim();
  const p = adminConfigPath();
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as { token?: string };
    return parsed.token && parsed.token.trim() ? parsed.token.trim() : null;
  } catch {
    return null;
  }
}

function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export function adminEnabled(): boolean {
  return adminToken() !== null || oidcAdminConfigured();
}

type AdminAuth = { ok: true; via: "token" | "oidc" } | { ok: false; status: 401 | 503 };

async function authenticateAdmin(header: string | null | undefined): Promise<AdminAuth> {
  const expected = adminToken();
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    return { ok: false, status: expected === null && !oidcAdminConfigured() ? 503 : 401 };
  }
  const presented = header.slice(7).trim();
  if (expected !== null && presented && tokenMatches(presented, expected)) return { ok: true, via: "token" };
  // OIDC admin claim path (only when the IdP is configured and the token
  // verifies; the claim check itself fails closed without config).
  const verified = await verifyBearer(header);
  if (verified && isAdminToken(verified)) return { ok: true, via: "oidc" };
  if (expected === null && !oidcAdminConfigured()) return { ok: false, status: 503 };
  return { ok: false, status: 401 };
}

// --- JSON helpers ------------------------------------------------------------------

function publicView(a: Account) {
  return {
    username: a.username,
    kind: kindOf(a.username),
    displayName: a.displayName ?? null,
    email: a.email ?? null,
    status: a.status ?? "active",
    oidcSubject: a.oidcSubject ?? null,
    hasPassword: !!a.passwordHash,
  };
}

function calendarView(m: CalendarMeta) {
  return {
    owner: m.owner, id: m.id, displayname: m.displayname, color: m.color,
    readers: m.readers, writers: m.writers, seq: m.seq,
  };
}

function fail(c: Context, status: 400 | 404 | 409 | 501, error: string) {
  return c.json({ error }, status);
}

async function bodyOf(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const optStr = (v: unknown): string | undefined => (typeof v === "string" ? v.trim() : undefined);

function requireSqlite(c: Context) {
  return storeBackend() === "sqlite" ? null : fail(c, 501, "admin plane requires the sqlite store");
}

// --- app -----------------------------------------------------------------------------

export function createAdminApp(): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const auth = await authenticateAdmin(c.req.header("Authorization"));
    if (!auth.ok) {
      if (auth.status === 503) return c.json({ error: "admin plane not configured" }, 503);
      return c.json({ error: "admin authentication required" }, 401, {
        "WWW-Authenticate": 'Bearer realm="caldav-hono-admin"',
      });
    }
    await next();
  });

  app.get("/principals", (c) => {
    const bad = requireSqlite(c); if (bad) return bad;
    return c.json({ principals: sqlite.listPrincipals().map(publicView) });
  });

  app.post("/principals", async (c) => {
    const bad = requireSqlite(c); if (bad) return bad;
    const body = await bodyOf(c);
    let username = optStr(body.username);
    const kind = optStr(body.kind) as PrincipalKind | undefined;
    if (username) {
      if (!USERNAME_RE.test(username)) return fail(c, 400, "username must look like ops-001 / emp-001 / drv-001");
    } else {
      if (!kind || !KINDS.includes(kind)) return fail(c, 400, `kind must be one of ${KINDS.join(", ")} (or give username)`);
      username = allocateUsername(kind, sqlite.knownUsernames());
    }
    if (sqlite.getPrincipal(username)) return fail(c, 409, `principal exists: ${username}`);
    const email = optStr(body.email) || defaultEmail(username);
    const taken = sqlite.listPrincipals().find((a) => (a.email ?? "").toLowerCase() === email.toLowerCase());
    if (taken) return fail(c, 409, `email already used by ${taken.username}`);
    const oidcSubject = optStr(body.oidcSubject) || null;
    if (oidcSubject && sqlite.findPrincipalByOidcSubject(oidcSubject)) return fail(c, 409, "oidcSubject already mapped");
    const password = generatePassword();
    const account = sqlite.createPrincipal({
      username,
      email,
      displayName: optStr(body.displayName) || username,
      passwordHash: hashPassword(password),
      status: "active",
      oidcSubject,
    });
    const provision = body.provision === false ? null : provisionPrincipal(account);
    return c.json({ principal: publicView(account), password, provision }, 201);
  });

  app.get("/principals/:u", (c) => {
    const bad = requireSqlite(c); if (bad) return bad;
    const a = sqlite.getPrincipal(c.req.param("u"));
    return a ? c.json({ principal: publicView(a) }) : fail(c, 404, "no such principal");
  });

  app.patch("/principals/:u", async (c) => {
    const bad = requireSqlite(c); if (bad) return bad;
    const u = c.req.param("u");
    if (!sqlite.getPrincipal(u)) return fail(c, 404, "no such principal");
    const body = await bodyOf(c);
    const patch: sqlite.PrincipalPatch = {};
    if (typeof body.displayName === "string") patch.displayName = body.displayName.trim() || u;
    if (typeof body.email === "string") {
      const email = body.email.trim();
      if (!email) return fail(c, 400, "email cannot be empty");
      const taken = sqlite.listPrincipals().find((a) => a.username !== u && (a.email ?? "").toLowerCase() === email.toLowerCase());
      if (taken) return fail(c, 409, `email already used by ${taken.username}`);
      patch.email = email;
    }
    if ("oidcSubject" in body) {
      const sub = typeof body.oidcSubject === "string" ? body.oidcSubject.trim() : "";
      if (sub) {
        const other = sqlite.findPrincipalByOidcSubject(sub);
        if (other && other.username !== u) return fail(c, 409, `oidcSubject already mapped to ${other.username}`);
      }
      patch.oidcSubject = sub || null;
    }
    const updated = sqlite.updatePrincipal(u, patch);
    return c.json({ principal: publicView(updated as Account) });
  });

  app.post("/principals/:u/disable", (c) => {
    const bad = requireSqlite(c); if (bad) return bad;
    const updated = sqlite.updatePrincipal(c.req.param("u"), { status: "disabled" });
    return updated ? c.json({ principal: publicView(updated) }) : fail(c, 404, "no such principal");
  });

  app.post("/principals/:u/enable", (c) => {
    const bad = requireSqlite(c); if (bad) return bad;
    const updated = sqlite.updatePrincipal(c.req.param("u"), { status: "active" });
    return updated ? c.json({ principal: publicView(updated) }) : fail(c, 404, "no such principal");
  });

  app.post("/principals/:u/password", (c) => {
    const bad = requireSqlite(c); if (bad) return bad;
    const password = generatePassword();
    const updated = sqlite.updatePrincipal(c.req.param("u"), { passwordHash: hashPassword(password) });
    return updated ? c.json({ principal: publicView(updated), password }) : fail(c, 404, "no such principal");
  });

  app.post("/principals/:u/provision", (c) => {
    const bad = requireSqlite(c); if (bad) return bad;
    const a = sqlite.getPrincipal(c.req.param("u"));
    if (!a) return fail(c, 404, "no such principal");
    return c.json({ principal: publicView(a), provision: provisionPrincipal(a) });
  });

  app.delete("/principals/:u", (c) => {
    const bad = requireSqlite(c); if (bad) return bad;
    return sqlite.deletePrincipal(c.req.param("u")) ? c.body(null, 204) : fail(c, 404, "no such principal");
  });

  app.get("/principals/:u/calendars", (c) => {
    const bad = requireSqlite(c); if (bad) return bad;
    const u = c.req.param("u");
    if (!sqlite.getPrincipal(u)) return fail(c, 404, "no such principal");
    return c.json({ calendars: listCalendars(u).map(calendarView) });
  });

  const aclRoute = "/calendars/:owner/:cal/acl/:u";
  app.put(aclRoute, async (c) => {
    const bad = requireSqlite(c); if (bad) return bad;
    const meta = getCalendar(c.req.param("owner"), c.req.param("cal"));
    if (!meta) return fail(c, 404, "no such calendar");
    const u = c.req.param("u");
    if (!sqlite.getPrincipal(u)) return fail(c, 404, "no such principal");
    if (u === meta.owner) return fail(c, 400, "owner already has full access");
    const access = optStr((await bodyOf(c)).access);
    if (access !== "read" && access !== "write") return fail(c, 400, 'access must be "read" or "write"');
    meta.readers = meta.readers.filter((x) => x !== u);
    meta.writers = meta.writers.filter((x) => x !== u);
    if (access === "read") meta.readers = [...meta.readers, u].sort();
    else meta.writers = [...meta.writers, u].sort();
    updateCalendar(meta);
    return c.json({ calendar: calendarView(meta) });
  });

  app.delete(aclRoute, (c) => {
    const bad = requireSqlite(c); if (bad) return bad;
    const meta = getCalendar(c.req.param("owner"), c.req.param("cal"));
    if (!meta) return fail(c, 404, "no such calendar");
    const u = c.req.param("u");
    meta.readers = meta.readers.filter((x) => x !== u);
    meta.writers = meta.writers.filter((x) => x !== u);
    updateCalendar(meta);
    return c.json({ calendar: calendarView(meta) });
  });

  app.all("*", (c) => c.json({ error: "no such admin route" }, 404));
  return app;
}
