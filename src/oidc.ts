// OIDC Bearer auth (RFC 6750): verify an IdP-issued JWT against the
// IdP JWKS with jose (MIT), then map the token subject to a local
// account (principal). Basic auth stays in auth.ts; app.ts tries both.
//
// Configuration (env wins over file):
//   CALDAV_OIDC_ISSUER / CALDAV_OIDC_AUDIENCE / CALDAV_OIDC_JWKS_URL
//   CALDAV_OIDC_CONFIG (default: config/oidc.local.json, 0600, gitignored)
//     { "issuer": "...", "audience": "...", "jwksUrl": "...",
//       "subjects": { "<sub>": "<username e.g. drv-001>", ... } }
// OIDC is disabled unless issuer, audience and jwksUrl are all set.
// A subject with no entry in "subjects" is an auth failure.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { loadAccounts, type Account } from "./auth.js";
import { storeBackend } from "./store.js";
import * as sqlite from "./store-sqlite.js";

export interface OidcConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
  // Required access-token scope (default "caldav"). Anything finer
  // (which calendars are readable/writable) stays server-side with
  // the principal and per-calendar readers/writers, never in scopes.
  scope: string;
  subjects: Record<string, string>;
  // Admin plane via OIDC: a verified token whose claim `adminClaim`
  // equals (or, for arrays, contains) `adminValue` is an operator.
  // Both unset = OIDC tokens never reach the admin plane.
  adminClaim: string | null;
  adminValue: string | null;
}

export function oidcConfigPath(): string {
  return process.env.CALDAV_OIDC_CONFIG ?? join(process.cwd(), "config", "oidc.local.json");
}

// Reloaded per request like accounts: the file is tiny and subject
// edits take effect without a restart.
export function loadOidcConfig(): OidcConfig | null {
  let file: Partial<OidcConfig> = {};
  const p = oidcConfigPath();
  if (existsSync(p)) {
    try {
      file = JSON.parse(readFileSync(p, "utf8")) as Partial<OidcConfig>;
    } catch {
      return null;
    }
  }
  const issuer = process.env.CALDAV_OIDC_ISSUER ?? file.issuer ?? "";
  const audience = process.env.CALDAV_OIDC_AUDIENCE ?? file.audience ?? "";
  const jwksUrl = process.env.CALDAV_OIDC_JWKS_URL ?? file.jwksUrl ?? "";
  if (!issuer || !audience || !jwksUrl) return null;
  const scope = process.env.CALDAV_OIDC_SCOPE ?? file.scope ?? "caldav";
  const adminClaim = process.env.CALDAV_OIDC_ADMIN_CLAIM ?? file.adminClaim ?? null;
  const adminValue = process.env.CALDAV_OIDC_ADMIN_VALUE ?? file.adminValue ?? null;
  return {
    issuer, audience, jwksUrl, scope, subjects: file.subjects ?? {},
    adminClaim: adminClaim || null, adminValue: adminValue || null,
  };
}

export function oidcEnabled(): boolean {
  return loadOidcConfig() !== null;
}

// One remote JWK set per URL. jose caches keys (cacheMaxAge) and, on
// an unknown kid, refetches after a short cooldown, so IdP key
// rotation is picked up without a restart. A failed refetch fails
// verification (fail closed) instead of trusting stale keys forever.
let cachedJwks: { url: string; getKey: JWTVerifyGetKey } | null = null;

function envMs(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function getJwks(jwksUrl: string): JWTVerifyGetKey {
  if (cachedJwks?.url === jwksUrl) return cachedJwks.getKey;
  const getKey = createRemoteJWKSet(new URL(jwksUrl), {
    // Overridable for tests (fast key-rotation checks); defaults are
    // the production values.
    cacheMaxAge: envMs("CALDAV_OIDC_JWKS_CACHE_MAX_AGE_MS", 5 * 60 * 1000),
    cooldownDuration: envMs("CALDAV_OIDC_JWKS_COOLDOWN_MS", 30 * 1000),
    timeoutDuration: envMs("CALDAV_OIDC_JWKS_TIMEOUT_MS", 5 * 1000),
  });
  cachedJwks = { url: jwksUrl, getKey };
  return getKey;
}

// Asymmetric algorithms only: rejects alg=none and HMAC confusion.
const ALGORITHMS = [
  "RS256", "RS384", "RS512", "PS256", "PS384", "PS512",
  "ES256", "ES384", "ES512", "EdDSA",
];

export interface VerifiedBearer {
  payload: JWTPayload;
  sub: string;
  scopes: string[];
}

// Signature/issuer/audience/expiry check plus the CalDAV scope. Shared by
// principal auth and the admin plane's OIDC path.
export async function verifyBearer(
  header: string | null | undefined,
): Promise<VerifiedBearer | null> {
  if (!header || !header.toLowerCase().startsWith("bearer ")) return null;
  const config = loadOidcConfig();
  if (!config) return null;
  const token = header.slice(7).trim();
  if (!token) return null;
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, getJwks(config.jwksUrl), {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ALGORITHMS,
      clockTolerance: 5,
    }));
  } catch {
    return null;
  }
  // IdPs put granted scopes in "scope" (space-separated, RFC 8693)
  // or "scp" (array); accept either.
  let scopes: string[] = [];
  if (typeof payload.scope === "string") scopes = payload.scope.split(/\s+/).filter(Boolean);
  else if (Array.isArray(payload.scp)) scopes = payload.scp.filter((s): s is string => typeof s === "string");
  if (!payload.sub) return null;
  if (!scopes.includes(config.scope)) return null;
  return { payload, sub: payload.sub, scopes };
}

// Subject -> principal: the static map in the config file first, then
// the oidc_subject column the admin plane maintains (SQLite store).
function principalForSubject(config: OidcConfig, sub: string): Account | null {
  const username = config.subjects[sub];
  if (username) return loadAccounts().find((a) => a.username === username) ?? null;
  if (storeBackend() === "sqlite") return sqlite.findPrincipalByOidcSubject(sub);
  return null;
}

export async function authenticateBearer(
  header: string | null | undefined,
): Promise<Account | null> {
  const verified = await verifyBearer(header);
  if (!verified) return null;
  const config = loadOidcConfig();
  if (!config) return null;
  return principalForSubject(config, verified.sub);
}

export function oidcAdminConfigured(): boolean {
  const config = loadOidcConfig();
  return !!config && !!config.adminClaim && !!config.adminValue;
}

// True when the (already verified) token carries the configured admin
// claim/value. Never true without both configured.
export function isAdminToken(verified: VerifiedBearer): boolean {
  const config = loadOidcConfig();
  if (!config || !config.adminClaim || !config.adminValue) return false;
  const v = verified.payload[config.adminClaim];
  if (typeof v === "string") return v === config.adminValue || v.split(/\s+/).includes(config.adminValue);
  if (Array.isArray(v)) return v.includes(config.adminValue);
  return false;
}
