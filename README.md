# caldav-hono

Lightweight CalDAV server on Hono (Node). Clean-room implementation
from RFC 4791 (CalDAV) / 5545 (iCalendar) / 6578 (sync-collection) /
4918 (WebDAV). No existing server code was translated or copied; other
servers served only as behavioral references.

## Run

```sh
npm install
npm run seed     # creates config/accounts.local.json (0600) + the built-in starter calendar set
npm start        # http://0.0.0.0:5232 (PORT / HOST env to override)
npm run verify   # discovery/CRUD/calendar-query/sync-collection/permissions
npm run offer    # offer flow replay (direct write -> ACCEPTED -> stage move)
npm run verify-recurrence  # recurrence expansion + free-busy (needs server up)
npm run verify-oidc  # OIDC Bearer checks vs. a local test issuer (self-contained)
npm run verify-scheduling  # same-server scheduling round trip + Part C SQL (self-contained, SQLite)
npm run migrate   # one-shot file store -> SQLite import (idempotent, cross-checks counts)
npm run offer-queries  # Part C offer searches as SQL (--driver/--start/--end/--now)
npm run verify-admin   # admin plane: provisioning, OIDC subject map, disable/delete (self-contained)
npm run verify-offer-dedupe  # one resource per offer UID + inbox policy (self-contained)
npm run verify:e2e  # all of the above in one go against an isolated throwaway server (CI entry)
```

One command for CI (Zuul check/gate shape): `npm run verify:e2e` builds
once (`tsc`, which is also the type check), seeds and starts an isolated
server (temp dir, free 127.0.0.1 port, SQLite; never the running
instance), runs every suite above from `dist/` in order, prints a
per-suite PASS/FAIL table and exits 1 if any suite fails. Needs only
`npm ci` beforehand; no network access at run time. `CALDAV_E2E_KEEP=1`
keeps the temp dir on failure, `CALDAV_E2E_SUITE_TIMEOUT_MS` caps each
suite (default 600000), `CALDAV_E2E_ONLY=a,b` runs a subset.

Node 22.13+ (`engines.node`): the SQLite store uses the built-in
`node:sqlite`.

Passwords live only in `config/accounts.local.json` (gitignored) and,
with the SQLite store, as scrypt hashes in the principals table.

Storage backend is chosen by `CALDAV_STORE`: `sqlite` (default; one
database at `CALDAV_DB`, default `data/caldav.sqlite`, via Node's
built-in `node:sqlite`) or `file` (the original layout, one `.ics` file
per resource under `data/`; the rollback path). Handlers only talk to
`src/store.ts`; the SQLite backend lives in `src/store-sqlite.ts`.
Opening an empty SQLite database in a data dir that still holds the
file layout imports it once (same as `npm run migrate`), preserving seq
numbers and journal so existing sync-tokens stay valid. `CALDAV_DATA`
relocates the data dir, `CALDAV_ACCOUNTS` the accounts file.

With the SQLite store the accounts file is a seed: its entries are
copied into the principals table at open (password hashed) and keep
following the file on later opens until the admin plane touches the
principal; from then on the table is the source. Principals created by
the admin plane exist only in the table.

## Admin plane (provisioning)

`/admin/*` is a JSON API with its own credential, separate from the
CalDAV Basic/OIDC principal credentials (a principal credential is
refused there, and the admin credential is refused on the CalDAV
side). It is for the SaaS side to create and manage principals; the
CalDAV protocol surface cannot create accounts. Requires the SQLite
store (501 otherwise).

Credential: `CALDAV_ADMIN_TOKEN` env, or `config/admin.local.json`
(`{"token": "..."}`, 0600, gitignored; `CALDAV_ADMIN_CONFIG`
relocates), sent as `Authorization: Bearer <token>`. Alternatively an
OIDC access token (verified like any Bearer) whose claim `adminClaim`
equals or contains `adminValue` (`config/oidc.local.json` or
`CALDAV_OIDC_ADMIN_CLAIM` / `CALDAV_OIDC_ADMIN_VALUE`). With neither
configured every `/admin` request is 503: the plane never opens
unauthenticated.

| method | path | body / result |
| --- | --- | --- |
| GET | `/admin/principals` | list (no secrets) |
| POST | `/admin/principals` | `{kind: ops\|emp\|drv}` allocates the next `kind-NNN` (or `{username}` in that form), `displayName?`, `email?` (default `<username>@example.test`, `CALDAV_MAIL_DOMAIN`), `oidcSubject?`, `provision?` (default true) -> 201 with the one-time `password` and the initial calendar set |
| GET / PATCH | `/admin/principals/:u` | PATCH `displayName` / `email` / `oidcSubject` (null clears) |
| POST | `/admin/principals/:u/disable`, `/enable` | a disabled principal gets 403 on every CalDAV request (credentials still verify, so clients do not re-prompt) |
| POST | `/admin/principals/:u/password` | issue / reset; the new password is in the response once |
| POST | `/admin/principals/:u/provision` | (re)apply the initial calendar set, idempotent |
| DELETE | `/admin/principals/:u` | principal, every calendar it owns, every grant it holds; the ID is never reallocated |
| GET | `/admin/principals/:u/calendars` | owned calendars with readers/writers |
| PUT / DELETE | `/admin/calendars/:owner/:cal/acl/:u` | PUT `{access: "read"\|"write"}` grants, DELETE revokes |

Built-in starter calendar set (applied by `provision` and by `npm run
seed`): every principal gets `default` and the schedule `inbox`;
`ops-xxx` gets `stage-request` / `stage-booked` / `stage-dispatched`
readable by every emp/drv and reads every driver's `avail`; `drv-xxx`
gets `avail` readable by every ops; emp/drv read every ops stage
calendar. This set models a request -> booked -> dispatched workflow
and is only the starting point the server ships with: the calendars are
ordinary CalDAV collections, so they can be renamed, removed or
re-granted through the admin plane and the protocol. Operators are not
made writers of a driver's default calendar: offers reach drivers
through scheduling delivery.

## Implemented subset

- Discovery: `/.well-known/caldav` (307), PROPFIND for
  current-user-principal, calendar-home-set, calendar list
  (displayname, calendar-color, CTag, sync-token, privileges).
- MKCALENDAR / MKCOL, PROPPATCH (displayname, calendar-color), DELETE calendar.
- Event PUT/GET/HEAD/DELETE with ETag, If-Match / If-None-Match (412).
- MOVE between calendars (used for stage transitions).
- REPORT calendar-query (time-range over expanded recurrence
  occurrences), calendar-multiget, sync-collection
  (journal-backed diffs incl. deletions as 404), free-busy-query
  (VFREEBUSY from the same expansion; readers only).
- Recurrence expansion on the read path (`src/recurrence.ts`):
  RRULE (DAILY/WEEKLY/MONTHLY/YEARLY etc., INTERVAL, COUNT, UNTIL,
  BY* parts), RDATE, EXDATE, EXRULE, RECURRENCE-ID overrides incl.
  RANGE=THISANDFUTURE; DATE, UTC, floating and IANA-TZID date-times
  (wall clock kept across DST). `<C:expand>` returns flat instances
  in query/multiget responses. RRULE evaluation uses the `rrule`
  package behind that one module. Rules that cannot be interpreted
  emit a countable `recurrence diagnostic` server log line and fall
  back to matching from DTSTART on, instead of vanishing silently.
- Basic auth and OIDC Bearer auth (either scheme resolves to the same
  principal); per-calendar readers/writers (meta.json or the
  calendar_acl table). Owners have full access; stage calendars are
  read-only for drivers.
- SQLite store (`src/store-sqlite.ts`): events (href PK, iCalendar
  source, index columns uid/dtstart/dtend/rrule/summary/organizer,
  etag = content hash), event_attendees (attendee, PARTSTAT,
  X-RESPONSE-DUE), calendars/principals/calendar_acl, a journal table
  (per-calendar sequence = sync-token, deletions as tombstones) and an
  occurrences projection rebuilt on every write from the recurrence
  engine (EXDATE and RECURRENCE-ID overrides applied; derived, not the
  source). Each mutation is one transaction: event row + indexes +
  projection + journal + seq bump commit together.
- Same-server scheduling (RFC 6638 subset, `src/scheduling.ts`):
  an organizer PUT with ATTENDEEs delivers a METHOD:REQUEST to each
  mapped attendee's schedule-inbox and a copy into their default
  calendar. Attendees never edit the organizer's resource: a PARTSTAT
  change on their own copy becomes a METHOD:REPLY to the organizer's
  inbox and the server applies it to the master. ACCEPTED is a
  conditional update inside the transaction (first ACCEPTED wins; a
  later ACCEPTED is logged and not applied). Organizer DELETE (or
  dropping an attendee) delivers METHOD:CANCEL and removes the
  server-delivered copies; an attendee deleting their copy reads as
  DECLINED. principal <-> address mapping comes from the principals
  (accounts file / table). MOVE does not trigger scheduling (stage
  moves are operator bookkeeping).
- One resource per UID per calendar (RFC 4791 no-uid-conflict):
  delivery updates whatever resource already carries the UID in the
  attendee's default calendar instead of adding a copy, and an
  organizer direct-writing their own invitation into an attendee's
  calendar (the legacy direct-write offer path, still used by
  `npm run offer`) replaces the server-delivered copy. Anyone else
  putting a second resource with an existing UID gets 403
  `CALDAV:no-uid-conflict`.
- Inbox policy: the schedule-inbox is reachable only through
  `schedule-inbox-URL` (not listed in the calendar home, resourcetype
  `schedule-inbox` without `calendar`, so DAVx5-style clients never
  sync it). Per inbox and UID only the latest organizer message
  (REQUEST/CANCEL) and the latest REPLY per attendee are kept; an
  attendee's REQUEST disappears once they answered or deleted their
  copy; messages older than `CALDAV_INBOX_RETENTION_DAYS` (default 30,
  0 keeps forever; judged by the message DTSTAMP set at delivery) are
  swept on delivery and at startup.

## OIDC (Bearer)

Copy `config/oidc.example.json` to `config/oidc.local.json` (0600,
gitignored) and set `issuer`, `audience`, `jwksUrl` for the IdP
(e.g. Logto: issuer `https://<tenant>.logto.app/oidc`, JWKS
`<issuer>/jwks`), plus `subjects`: a map from IdP token subject
(`sub`) to a local account username (`ops-001` / `emp-001` /
`drv-001`); with the SQLite store the `oidcSubject` kept per principal
by the admin plane is consulted after that map. The three IdP values
can instead come from
`CALDAV_OIDC_ISSUER` / `CALDAV_OIDC_AUDIENCE` / `CALDAV_OIDC_JWKS_URL`
(env wins); `CALDAV_OIDC_CONFIG` relocates the file. Tokens are
verified with jose against the remote JWKS (signature, issuer,
audience, expiry; asymmetric algorithms only), and the token must
carry the CalDAV scope (`scope`, default `caldav`). That single
scope is all the server demands: which calendars a principal may
read or write stays server-side (per-calendar readers/writers) and
is never baked into scopes. Keys are cached
(5 min) and refetched on unknown `kid`, so IdP key rotation needs
no restart. A subject with no map entry fails authentication.
Basic auth keeps working alongside Bearer (verification environments
and app passwords). `npm run verify-oidc` exercises this against a
local test issuer.

## Known limitations

- Recurrence: TZID resolution uses IANA names via Intl; custom
  VTIMEZONE definitions are passed through on output but not used
  for conversion (unknown TZID -> diagnostic + wall time as UTC).
  Floating times are compared as UTC. Expansion is computed per
  request on the read path (no projection table yet) with scan caps
  (100k rule iterations / 10k occurrences per resource, diagnosed
  when hit); open-ended queries without an end expand ~10 years out.
  A THISANDFUTURE that restarts or cancels the series makes later
  splits no-ops (diagnosed).
- PROPFIND returns the full useful prop set instead of filtering to the
  requested props; no 404 propstats for unknown props.
- Scheduling is same-server only (no iMIP/email delivery, no
  SCHEDULE-STATUS, no scheduling-outbox, master component only: no
  per-occurrence RECURRENCE-ID replies). No CardDAV, no shared calendar
  discovery beyond the home listing of granted calendars.
- The accounts file still holds plain-text passwords (0600) for the
  file store and as the SQLite seed. Admin-created principals have
  hashes only. IdP group/claim mapping exists only for the admin role.
- The admin plane is sqlite-only (file store answers 501); there is no
  CLI wrapper yet and no audit log of admin calls.
- Single process; file backend uses synchronous file IO and its
  check-then-write reply application is atomic only within the process;
  journal never truncated in either backend. The file backend is kept
  as the rollback path (`CALDAV_STORE=file`), not developed further.

## Dependencies and licenses

| package | use | license |
| --- | --- | --- |
| hono | HTTP framework | MIT |
| @hono/node-server | Node adapter | MIT |
| jose | JWT/JWKS verification (OIDC Bearer) | MIT |
| rrule | RRULE evaluation inside `src/recurrence.ts` only | BSD-3-Clause |
| node:sqlite (built-in) | SQLite backend; no npm package (Node.js is MIT, SQLite is public domain) | MIT / public domain |
| typescript (dev) | build/typecheck | Apache-2.0 |

iCalendar and XML handling are hand-written for the subset above; the
only delegated iCalendar semantics is RRULE evaluation via rrule.

## License

MIT. See `LICENSE`.
