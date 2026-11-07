// The accounts file (config/accounts.local.json, 0600, gitignored).
// With the file store it is the whole account database, reloaded per
// request. With the SQLite store it is only a seed: principals are read
// from the principals table (admin plane), and file entries are copied
// in at open for usernames the admin plane has not taken over.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface FileAccount {
  username: string;
  password: string;
  email?: string;
  displayName?: string;
}

export function accountsPath(): string {
  return process.env.CALDAV_ACCOUNTS ?? join(process.cwd(), "config", "accounts.local.json");
}

export function readAccountsFile(): FileAccount[] {
  const p = accountsPath();
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as { accounts: FileAccount[] };
    return parsed.accounts ?? [];
  } catch {
    return [];
  }
}

// Calendar-user address domain for principals created without an email.
export function mailDomain(): string {
  return process.env.CALDAV_MAIL_DOMAIN ?? "example.test";
}
