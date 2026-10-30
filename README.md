# Retro Vault

A public EmulatorJS library with browser saves and password-protected management,
served by Cloudflare Workers. The default emulator is pinned to **4.3.0-pre**.

## Site versions

The current Retro Vault release is **2.12.1**. Site releases use
`major.minor.patch`: increment the patch for fixes, the minor for compatible
features, and the major for incompatible changes. Update `version.txt`, the root
package and lockfile versions, diagnostic `appVersion` values, asset query
versions (including the local ROM reader worker), and the changelog together.
The EmulatorJS runtime has its own independent version.

Earlier date-based releases were renumbered by the scope of each update.
The first release is 1.0.0. Feature additions increment the minor number, fixes
increment the patch, and the Workers/D1/R2 architecture migration starts 2.0.0.
The changelog retains the original release dates and content.

| Original release | Site version | Original release | Site version |
| --- | --- | --- | --- |
| 1 | 1.0.0 | 15 | 2.0.0 |
| 2 | 1.1.0 | 16 | 2.1.0 |
| 3 | 1.2.0 | 17 | 2.2.0 |
| 4 | 1.3.0 | 18 | 2.3.0 |
| 5 | 1.4.0 | 19 | 2.4.0 |
| 6 | 1.4.1 | 20 | 2.4.1 |
| 7 | 1.4.2 | 21 | 2.5.0 |
| 8 | 1.4.3 | 22 | 2.6.0 |
| 9 | 1.4.4 | 23 | 2.6.1 |
| 10 | 1.5.0 | 24 | 2.7.0 |
| 11 | 1.5.1 | 25 | 2.8.0 |
| 12 | 1.6.0 | 26 | 2.8.1 |
| 13 | 1.6.1 | 27 | 2.9.0 |
| 14 | 1.6.2 | 28 | 2.10.0 |

The version-numbering update is 2.10.1. Original release 1 used `20261028`;
subsequent date-based IDs ended in the original release number.

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

Local ROMs are passed directly as named `File` objects to the pinned runtime,
without a local blob URL download or an extra pre-read. Existing local game and
save identities remain unchanged. If startup fails, export the diagnostic log;
it includes the local read state and size, plus recent resource request failures.

The library header places search, language, and local ROM controls at the upper
right. System filters show counts for the full published library. The bottom
summary shows the filtered game count and sum of each displayed entry's ROM bytes,
excluding thumbnails, BIOS, patches, drafts, and trash. This is a library ROM total,
not an R2 storage/billing total. Missing ROM metadata displays an unknown-size
label rather than silently treating missing sizes as zero.

The public catalog includes a read-only `romSize` field derived from stored file
metadata; catalog exports do not include it. Management and device saves use the
same Vault palette, square panels, pixel logo, and shared `vault-theme.css`.

## Add and edit games

1. Open `/admin/` and choose **Add game**.
2. Choose a ROM to upload. ROM and thumbnail pickers support multiple selection.
   A recognized extension automatically selects the system and its default core,
   both for uploads and when selecting an already uploaded ROM. This also works
   when editing an existing game. Choosing another ROM for the same system keeps
   its custom core. You can change the detected system or core afterward.
   Ambiguous extensions such as ZIP, BIN, and ISO keep the current manual choice.
3. Enter an English title, a Japanese title, or both, and choose the system. The
   interface prefers its current language and falls back to the other title.
   Both titles are searchable. Existing legacy `title` entries still display;
   their title is loaded into the primary title field when edited. The core defaults to that system's core,
   with supported alternate cores available in the dropdown.
4. Upload or select a thumbnail. PNG, JPEG, and WebP uploads up to 10 MiB are
   resized to at most 1024 pixels per side and encoded as WebP in the browser.
5. Select **Visible in library** and save. Required referenced files must have
   completed uploading before a game can become visible.

Multiple files upload one at a time. The first successful upload is selected for
the current game; later uploads remain in the uploaded-file dropdowns for other
games. Each catalog entry still uses one ROM and one thumbnail. Uploading multiple
ROMs does not automatically create or publish game entries, and thumbnails are
not matched to ROMs by filename. Choose the corresponding files and save each game.
An existing game's ID and title are retained during a batch. Its system follows
the first successfully uploaded ROM, and later files do not change that choice.
The first picked ROM previews its detected system immediately; if no ROM upload
completes, the previous system/core settings are restored.

The queue displays each file's result. A fixed panel at the bottom right shows
the current file number, bytes sent, and progress during each request. It remains
visible while scrolling and waits for the server commit before reaching 100%.
Completion and error notifications appear at the bottom right without moving
the page. Completion notifications expire after eight seconds; errors remain
until dismissed. Player errors appear once inside the player, including in
fullscreen, without adding bars above or below the game.
An individual failure does not discard completed files or stop later files.
Cancel stops the current upload and remaining queue; completed uploads stay in
storage. File sizes use B, KiB, MiB, or GiB so small files do not round to zero.

ROM/BIOS/patch files are sent in 16 MiB parts, sequentially, with bounded retries
for a failed part. The Worker streams each part to R2. Progress and cancellation
are available. The default per-file maximum is 8 GiB, configurable with
`MAX_ROM_BYTES`. Browser memory and emulator compatibility remain separate limits.
A browser reload does not automatically resume an interrupted upload; staged
entries can be removed from File storage before retrying.
File storage groups ROMs, thumbnails, BIOS files, and patches into separate
expandable categories. Each heading shows its file count and completed size.
Categories start collapsed and keep their open state during updates and language
changes on the current page. Empty categories show an empty-state message.

The advanced JSON editor supports the current Retro Vault fields. Apply JSON to
the form before saving. Unsupported fields are rejected rather than silently
removed. Revision checks reject stale edits from another tab.

Deleting a game first moves it to trash. Restoring returns it to draft. Removing
an entry permanently does **not** delete shared ROM/image files. Delete unused
files explicitly in File storage; references from drafts and trash also protect
files from deletion. Storage totals describe completed catalog files, not an exact
Cloudflare bill or the size of incomplete multipart data.

## Change game order

Use **Up** and **Down** beside a game in management. Each move saves immediately
to D1; no separate save button is required for ordering. Clear search before
moving entries. Drafts participate in the same order, and trash does not show
move controls. Public lists, search results, system-filtered lists, and the NES
comparison retain the saved relative order. Other open library pages update on
reload. New entries append at the end.

Reordering changes neither game IDs nor save names and does not submit or discard
unsaved editor fields. An order revision prevents an older tab from overwriting
a newer order; additions and permanent removals advance that revision as well.
On conflict, management refreshes the list and keeps the editor intact.

The order table and triggers are initialized automatically on deployment use;
existing databases begin in their previous ID order. JSON export lists entries
in saved order, and import appends them in the supplied array order. Restoring a
trashed entry retains its position; removing it permanently removes its order
entry. No separate database migration command is needed.

## Import the existing library

The old `data/games.json` is not uploaded as a static asset. Import it from the
management page. Existing positive numeric IDs are retained; duplicate or already
used IDs reject the import without overwriting existing games. Imported entries
start as drafts. Upload their ROMs/thumbnails and select those uploaded files,
then make the entries visible.

The export downloads the catalog, including draft/trash status, as JSON. Import
adds entries only; use each entry's editor to update an existing ID. A ROM or BIOS
is never included in a JSON export or in this source ZIP.

Supported configuration fields include `id`, `title`, `titleEn`, `titleJa`, `system`, `core`,
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

Nine shared device-local state slots, `.rvstate` import/export, legacy-state import,
manual game-save writes, and native save-file import/export remain available.
State metadata checks game identity, actual backend core, and emulator version.
Cloud save synchronization is not introduced by the catalog database.

The player waits for a tap on the native Start Game button. Ordinary systems use
threads OFF; required cores such as Azahar enable threads when supported. The
Worker sends COOP/COEP headers for shared memory, including API/error responses.
Closing pauses the game, bounds save flushing, closes tracked audio contexts,
releases canvas/object URLs, then unloads the iframe. Errors keep the player open.

The 4.3.0-pre mobile Safari startup audio check is replaced by a compatibility
helper because the runtime can have no OpenAL current context. A trusted tap
can resume an existing suspended audio context without consuming game input.
No extra context or blocking audio popup is created. All hooks are removed on
shutdown. Other versions retain their native startup check.

Named operation failures and aggregate input counts help distinguish browser
input delivery from calls to the emulator's input interface. Key values and
button contents are not recorded. The earlier stackless permission denial and
reported touch-input failure are not fully diagnosed by the original log;
validate on the affected device and retain a fresh diagnostic after a failure.

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

Local 3DS padding preparation is a Retro Vault feature, not an EmulatorJS option.
It inspects standard CARD1 NCSD/NCCH boundaries and verifies every omitted byte
is 0xFF using at most 4 MiB per read, before creating a sliced File for startup.
The original file and original filename/size used for save identity stay intact.
A corner panel provides progress and cancellation. CARD2, nonstandard media
units, malformed layouts, and tails containing other bytes are left unchanged.
This does not guarantee that the remaining ROM fits browser or core memory.

Local 3DS files of at least 256 MiB use a bounded read-only adapter on exactly
4.3.0-pre / Azahar. It bypasses the frontend ROM arrayBuffer/cache/MEMFS write
path. Reads use 1 MiB local Blob slices and an 8 MiB LRU cache. A worker-side 256-byte binary
compatibility probe must pass. Unsupported environments fail without falling
back to full allocation. This is not WORKERFS: a dedicated worker uses FileReaderSync on slices, sharing
results through a 1 MiB SharedArrayBuffer. The synchronous core briefly waits
for each uncached block, with a five-second timeout. The core may still allocate its own
memory. Safari gameplay and performance are not established by the FS tests.
Diagnostics record romIO counters; no source ROM is modified or uploaded.

## Library 3DS range reads

Version 2.11.0 extends the pinned Azahar read-only adapter to same-origin library
ROM URLs under `/data/roms/`. Raw 3DS/CCI/CXI/APP/ELF/AXF files are supported;
compressed archives are not supported by this path. An initial 256 KiB range
verifies HTTP 206, Content-Range, object size, and ETag. Later reads must match the
same object and range exactly. Bodies are consumed with a strict size bound;
HTTP 200 does not trigger a full-file fallback. No ROM bytes are written to MEMFS.
The cache holds at most 8 MiB, with 256 KiB network blocks. Local blocks remain
1 MiB. Games, source objects, and save identifiers are unchanged.

The current core requires synchronous filesystem reads, so a cache miss can
block the player UI while the worker fetches a range. Each fetch times out after
4.5 seconds and the shared-memory wait is capped at 5 seconds. This can affect
playability on slow connections. Each uncached block is another R2 read request;
this is not a single full-ROM download or a persistent offline ROM cache.
Core-internal memory allocations remain outside this adapter's cache bound.
Diagnostic `romIO` records mode, object size, reads, fetched bytes, cache size,
and pending block offsets. Startup phases now distinguish core initialization,
file preparation, ROM loading, and game startup. A full Safari game boot is not
verified by the synthetic file-read checks.

## Shared state slots (2.12.0)

The panel, native quick-save/load methods (including context-menu actions),
keyboard shortcuts, and native state toolbar use one set of slots 1–9. The panel
shows the native selected slot and can change it. Native key 1 saves, key 2
loads, and key 3 cycles selection. Quick saves overwrite without confirmation;
panel overwrite/load/delete actions retain their confirmations. The native
single-state toolbar now saves/loads the selected shared slot, regardless of
its earlier download/browser location preference. Use the panel to export files.

Native quick-state files in the pinned runtime live in MEMFS. Retro Vault
persists immutable snapshots to the existing `RetroVault-saves` database and
restores a selected snapshot to the native quick-state path on demand. It does
not hydrate all nine large payloads at startup. Completed writes survive normal
player/browser restarts. Wait for the device-save completion notice before
leaving; abrupt browser termination can interrupt an in-flight write. Game saves
and state backups remain device-local, without cloud synchronization.

The database name, schema, game identities, and slots 1–3 are unchanged. Existing
custom slots therefore become shared slots without data conversion or deletion.
The same core/version compatibility checks apply to native loads and the panel;
incompatible older records remain exportable. The earlier native single browser
state is still available through the explicit legacy import button. Slot listing
reads metadata only. There is no periodic state capture. Native saves are queued
in order and a failed write leaves the previous committed snapshot intact. Close
cleanup waits for queued persistence alongside existing game-save flushing.

## DS canvas touch routing (2.12.1)

The pinned 4.3.0-pre frontend applies `ejs-canvas-no-pointer` to the canvas on
touch devices, disabling pointer hit testing. For DS backends only, runtime
support adds a scoped `rv-ds-touch` host class. CSS restores canvas hit testing
and `touch-action: none`, lets empty gamepad containers pass through touches,
and leaves actual virtual buttons and D-pad hit areas interactive. The existing
core receives native browser events and retains its coordinate/layout handling;
no synthetic stylus coordinates or replacement input driver are introduced.
Other systems and explicitly older runtimes retain their existing behavior.
The class is removed during shutdown. Diagnostics record only canvas event
counts and routing mode, without coordinates or input contents. Game-level
stylus behavior on the reporting Safari device is not yet verified.
