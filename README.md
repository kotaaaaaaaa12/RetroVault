# Retro Vault

A public EmulatorJS library with browser saves and password-protected management,
served by Cloudflare Workers. The default emulator is pinned to **4.3.0-pre**.

## Deploy from GitHub with Workers Builds

Create a **Workers** project from this repository, not a Pages project.
Use the directory containing `wrangler.jsonc` as the project root.

| Setting | Value |
| --- | --- |
| Build command | Leave empty |
| Deploy command | `npx wrangler deploy` |
| Non-production branch deploy command | Disable until separate preview storage is configured |

Wrangler's internal build hook runs `scripts/prepare-assets.mjs`, copies the
interface into `.retrovault/public`, bundles the Worker, and uploads the assets.
No separate dashboard build command, output directory, frontend framework, or
manual D1 migration command is needed.

Wrangler 4.154.0 is pinned in `package.json` and the lockfile. Its automatic
resource provisioning creates the **DB** D1 binding and **FILES** R2 binding on
first deployment. Keep the Worker name and binding names stable on later deploys.
Wrangler reuses the existing linked resources. Database tables and guards are
initialized idempotently on the first API request.

Enable R2 on the Cloudflare account if it has not been activated yet. Use Standard
storage. The bucket should remain private: do not enable an r2.dev URL or a public
bucket custom domain. The Worker streams files used by published games without a
login. Draft, trashed, and unused files require an administrator session unless
another published game references the same file.

## Set the administrator password once

The deployment contains **no default password**. In Cloudflare, open your Worker,
**Settings → Variables and Secrets**, add a value with type **Secret**, and use:

| Setting | Value |
| --- | --- |
| Name | `ADMIN_PASSWORD` |
| Value | Your chosen login password, entered directly |

Save and deploy the settings change, then enter the exact same password on the
login page. No terminal, password generator, or manually generated hash is needed.
Use a unique password, preferably at least 12 characters. Passwords may contain
Unicode and punctuation; leading and trailing spaces are significant. The maximum
length is 1024 characters. An empty secret disables login.

Alternatively, an authenticated local terminal can use
`npx wrangler secret put ADMIN_PASSWORD` and enter the chosen password.
Do not put the password in `wrangler.jsonc`, GitHub, or public JavaScript.
Only the Worker reads the secret. The browser submits the entered password over
HTTPS; authentication responses never return the configured password.

Only `/admin/`, its management APIs, and the NES comparison test require this
login. The game library and player open without signing in, including before an
administrator password is configured. The login session lasts up to
12 hours. Sessions use Secure, HttpOnly, SameSite=Strict cookies; write APIs require
a session CSRF token and same-origin requests. Repeated login failures are limited.
Changing the password invalidates existing sessions.

An existing `ADMIN_PASSWORD_HASH` is supported only as a compatibility fallback
when `ADMIN_PASSWORD` is absent. A configured `ADMIN_PASSWORD` always takes
precedence, including when it is empty. Remove the old hash secret after switching.
The old hashing script remains available for compatibility but is not needed for
normal setup.

## Local development and verification

```sh
npm ci
npm test
npx wrangler deploy --dry-run
npx wrangler dev
```

For local development only, put your chosen password in a non-committed `.dev.vars`
file as `ADMIN_PASSWORD="your-local-password"`. Local D1 and R2 data persist under
Wrangler's development storage. Tests use a synthetic password and synthetic bytes;
they do not supply a production administrator password or game ROM.

Production deployment from an authenticated local environment uses the same single
command as Workers Builds:

```sh
npx wrangler deploy
```

The dry run verifies build and bundling; it does not deploy to your account.

## Routes and interface

- `/`: public game library, search, system filters, local ROM opening.
- `/pages/player.html`: public game player.
- `/admin/`: add/edit games, upload ROMs, thumbnails, BIOS files and patches,
  select a system and core, manage drafts and trash, import/export JSON.
- `/admin/core-test.html`: authenticated NES release comparison, linked from
  management. The old `/pages/core-test.html` route redirects here after login.
- `/pages/changelog.html`: release history and official EmulatorJS credit.
- `/api/games`: public compatible JSON list of visible games; drafts and trash are excluded.
- `/data/roms/…`, `/data/thumbs/…`, `/data/bios/…`: public reads for files used by
  published games. Other completed files require an administrator session.

The main footer contains Changelog, the official EmulatorJS link, and the existing
diagnostic-log download when a log is available. Management is linked from the
header instead. Auto, English, and Japanese localization is shared across pages.
Safari phone-number detection is disabled on HTML pages.

## Add and edit games

1. Open `/admin/` and choose **Add game**.
2. Choose a ROM to upload. Known extensions suggest a system; ambiguous extensions
   leave system selection to you. An explicitly chosen system or core is retained.
3. Enter the title and choose the system. The core defaults to that system's core,
   with supported alternate cores available in the dropdown.
4. Upload or select a thumbnail. PNG, JPEG, and WebP uploads up to 10 MiB are
   resized to at most 1024 pixels per side and encoded as WebP in the browser.
5. Select **Visible in library** and save. Required referenced files must have
   completed uploading before a game can become visible.

ROM/BIOS/patch files are sent in 16 MiB parts, sequentially, with bounded retries
for a failed part. The Worker streams each part to R2. Progress and cancellation
are available. The default per-file maximum is 8 GiB, configurable with
`MAX_ROM_BYTES`. Browser memory and emulator compatibility remain separate limits.
A browser reload does not automatically resume an interrupted upload; staged
entries can be removed from File storage before retrying.

The advanced JSON editor supports the current Retro Vault fields. Apply JSON to
the form before saving. Unsupported fields are rejected rather than silently
removed. Revision checks reject stale edits from another tab.

Deleting a game first moves it to trash. Restoring returns it to draft. Removing
an entry permanently does **not** delete shared ROM/image files. Delete unused
files explicitly in File storage; references from drafts and trash also protect
files from deletion. Storage totals describe completed catalog files, not an exact
Cloudflare bill or the size of incomplete multipart data.

## Import the existing library

The old `data/games.json` is not uploaded as a static asset. Import it from the
management page. Existing positive numeric IDs are retained; duplicate or already
used IDs reject the import without overwriting existing games. Imported entries
start as drafts. Upload their ROMs/thumbnails and select those uploaded files,
then make the entries visible.

The export downloads the catalog, including draft/trash status, as JSON. Import
adds entries only; use each entry's editor to update an existing ID. A ROM or BIOS
is never included in a JSON export or in this source ZIP.

Supported configuration fields include `id`, `title`, `system`, `core`,
`coreOverride`, `saveName`, `rom`, `thumbnail`, `bios`, `patch`, `gameParent`,
`threads`, `videoRotation`, `disableCue`, `forceLegacyCores`, `ejsVersion`, and
`dataPath`. The system/core options are based on the pinned 4.3.0-pre core list.
Explicit other versions or custom data paths require their own compatibility
verification. `dataPath` takes precedence over `ejsVersion`, then the pinned default.

The `rom`, `thumbnail`, `bios`, `patch`, and `gameParent` fields contain R2 object
keys after upload. The interface displays their original file names. Advanced
JSON and exports retain the keys so references round-trip reliably.

## Saves and runtime behavior

Game IDs are stable. `core` keeps its existing library identity; `coreOverride`
selects another backend without rewriting that identity. `saveName` is fixed when
editing a title. JSON migration initializes it from the previous title to retain
native browser-state/settings names. Original uploaded ROM basenames are retained.
Changing the system, ROM filename/content, core, or emulator version can still
change save compatibility. Keep backups when changing those settings.

Three device-local state slots, `.rvstate` import/export, legacy-state import,
manual game-save writes, and native save-file import/export remain available.
State metadata checks game identity, actual backend core, and emulator version.
Cloud save synchronization is not introduced by the catalog database.

The player waits for a tap on the native Start Game button. Ordinary systems use
threads OFF; required cores such as Azahar enable threads when supported. The
Worker sends COOP/COEP headers for shared memory, including API/error responses.
Closing pauses the game, bounds save flushing, closes tracked audio contexts,
releases canvas/object URLs, then unloads the iframe. Errors keep the player open.

The footer's diagnostic download remains device-local. It measures WebAssembly
memory and bounded runtime metadata, not total Safari/GPU memory. Download a log
after a reload before starting another game. The NES comparison that motivated
the upgrade ran for 325 seconds in the submitted test; updated main-player
playback across all systems and Safari devices is not guaranteed.

## Move the existing custom domain

First deploy and verify the Worker on its workers.dev address. If the current
custom domain is attached to Pages, detach it there and add it as a custom domain
on this Worker when ready. The source configuration deliberately does not take
over or delete the existing Pages project or domain automatically.

Code deployment does not remove ROMs already committed to GitHub or its history.
After confirming the R2 migration and backups, remove those GitHub copies
and review history separately.

## Files and storage

`worker/` contains the request router, authentication, D1 schema/validation, and R2
upload/read handlers. Public interface sources stay in `assets/`, `pages/`, and
`admin/`; the preparation script copies only allowed interface file types from
those directories, plus `index.html`, `version.txt`, and `_headers`.

ROM, BIOS, root game-data directories, server source, tests, dependency folders,
and secrets are never copied into the public asset directory. Avoid placing ROMs
or secrets inside interface asset directories. Use `.gitignore` to keep local
secrets, generated output, and dependencies out of Git.
