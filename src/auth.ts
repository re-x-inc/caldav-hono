// Basic auth and the Account view of a principal. OIDC Bearer is in
// oidc.ts and resolves to the same Account; everything else keys off
// username regardless of which scheme authenticated.
//
// Where accounts come from depends on the store backend:
//   file   - config/accounts.local.json (plain-text passwords)
//   sqlite - the principals table (scrypt password hashes, status,
//            OIDC subject), seeded from the accounts file at open and
//            managed through the admin plane (admin.ts).

import { timingSafeEqual } from "node:crypto";
import { readAccountsFile } from "./accounts-file.js";
import { verifyPassword } from "./password.js";
import type { CalendarMeta } from "./store.js";
import { storeBackend } from "./store.js";
import * as sqlite from "./store-sqlite.js";

export { accountsPath } from "./accounts-file.js";
export { generatePassword, hashPassword, verifyPassword } from "./password.js";

export type PrincipalStatus = "active" | "disabled";

export interface Account {
  // Stable ID (e.g. ops-001). Identity keys off this; displayName is
  // presentation only and may keep a person's name.
  username: string;
  // Plain-text password (file store only); empty when a hash is used.
  password: string;
  // scrypt hash (SQLite store); checked instead of `password` when set.
  passwordHash?: string | null;
  email?: string;
  displayName?: string;
  status?: PrincipalStatus; // absent = active
  oidcSubject?: string | null;
}

// Reloaded per request: the accounts file is tiny and this makes
// account edits effective without a restart (file store). The SQLite
// store answers from the principals table.
export function loadAccounts(): Account[] {
  if (storeBackend() === "sqlite") return sqlite.listPrincipals();
  return readAccountsFile().map((a) => ({ ...a }));
}

export function findAccount(username: string): Account | null {
  return loadAccounts().find((a) => a.username === username) ?? null;
}

export function isDisabled(account: Account): boolean {
  return account.status === "disabled";
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function checkPassword(account: Account, password: string): boolean {
  if (account.passwordHash) return verifyPassword(password, account.passwordHash);
  if (!account.password) return false;
  return safeEqual(account.password, password);
}

// Returns the account on valid credentials, including a disabled one:
// the caller decides how a disabled principal is answered (403), so
// that a correct password on a stopped account does not look like a
// typo to the client.
export function authenticateBasic(header: string | null | undefined): Account | null {
  if (!header || !header.toLowerCase().startsWith("basic ")) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  const user = decoded.slice(0, colon);
  const pass = decoded.slice(colon + 1);
  const account = loadAccounts().find((a) => a.username === user || a.email === user);
  if (!account || !checkPassword(account, pass)) return null;
  return account;
}

export type Access = "owner" | "write" | "read" | null;

export function accessTo(meta: CalendarMeta, username: string): Access {
  if (meta.owner === username) return "owner";
  if (meta.writers.includes(username)) return "write";
  if (meta.readers.includes(username)) return "read";
  return null;
}
