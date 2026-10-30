# Retro Vault

A public EmulatorJS library with browser saves and password-protected management,
served by Cloudflare Workers. The default emulator is pinned to **4.3.0-pre**.

## Site versions

The current Retro Vault release is **2.16.0**. Site releases use
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


## DS direct touch mode (2.12.2)

For the pinned 4.3.0-pre melonDS backend, the player sets
`melonds_touch_mode = "Touch"` through EmulatorJS native default options. The
core's Mouse mode accumulates relative deltas and renders a movable cursor;
its Touch mode uses absolute pointer coordinates and the current screen layout.
Touch supports both mouse clicks and finger input through the native driver.
No coordinate injection or fixed pixel offset is added.

Existing per-game Mouse preferences migrate to Touch once. Explicit Joystick
and disabled preferences remain intact; subsequent manual mode changes are
respected. Save names, states, game saves, control bindings and cheats do not
change. Non-melonDS overrides and explicitly older runtimes are unchanged.
Diagnostics retain the last selected mode after closing the game and record
no pointer coordinates. This addresses the relative cursor behavior; the
reporting Safari device still needs game-level testing. Upstream also tracks
mobile Touch input failures separately in EmulatorJS issue #1262.

Source behavior was checked against the EmulatorJS melonDS fork at
`18a057d372783b42d7e297b8731f3c3d673cdcab`, `src/libretro/input.cpp` and
`src/libretro/libretro_core_options.h`. This source check does not establish
that every deployed core binary was built from that commit.


## Native ROM routing correction (2.12.4)

The pinned frontend calls `download(config.gameUrl, downloadType.rom)` with
`downloadType.rom.name === "ROM"`. Earlier adapter and diagnostic guards checked
`"rom"`. The range worker could finish its initial 256 KiB probe while the
native downloader proceeded to fetch the entire ROM separately. Earlier unit
fixtures and the direct Azahar-FS check used a lowercase invented download type
and did not cover the native `downloadFiles()` pipeline.

The adapter now owns its exact URL or File source, independent of the download
label. Other sources retain native behavior. The unsupported-adapter guard and
ROM phase tracking use the same exact-source comparison. Mount/read failures
do not retry through the full-file downloader. Existing cache limits, range
validation, save storage and core version remain unchanged.

A browser reproduction with the actual pinned frontend's `downloadFiles()`,
`initializeGameManager()` and `downloadType.rom`, plus the real pinned Azahar
file system, reproduced the old whole-file request. With the fix, a synthetic
4 GiB server object was accessed only through 256 KiB ranges, including offsets
above 2 GiB. The test stops before calling the game's entry point and does not
establish game compatibility or Safari startup success. The reporting Safari
log from 2.12.3 had a ready range probe, zero adapter reads, and a separate HTTP
200 ROM GET, consistent with this reproduced integration failure.


## Storage usage overview (2.13.0)

The management page's File storage section starts with a doughnut chart and
an accessible category table showing capacity, percentage, and file count.
It summarizes existing catalog/file metadata in the browser without reading
ROM bodies, querying R2 listings, or adding a statistics database.

Only completed (`ready`) file records are counted, once per storage key.
Uploading and deleting records are excluded; this is a completed-upload
inventory rather than an R2 billing report. ROMs use saved system associations
from all games, including drafts/trash and parent ROM references. Unattached
ROMs use recognized extensions. Conflicting system references, ambiguous core
aliases without a recognized extension, and unknown formats are unclassified.
Thumbnails, BIOS, patches, and unclassified ROMs each retain a separate row,
including when empty. Hardware rows appear for stored ROM files, and all rows
are ordered by capacity. Data refreshes after saves, uploads and deletions;
language changes rerender labels without changing totals. No chart service or
external chart library is used.


## Native 3DS startup diagnostics (2.13.1)

For the pinned Azahar backend only, runtime support wraps the native core
factory immediately before `initModule()` invokes it. It preserves the
frontend's print callbacks while retaining up to 20 native output lines of
500 characters, plus up to six issue lines. The earliest three issues remain
when later errors arrive. URL credentials, queries and fragments are removed.
Persistence is coalesced to once per second. Original callbacks and exceptions
are preserved, and hooks restore during shutdown.

Azahar entry-point arguments include `-v` to expose native startup messages;
the frontend production debug/cache configuration remains unchanged. Diagnostics
record entry-point invocation/return, numeric return code when available,
observed WebGL context creation and canvas dimensions. No additional graphics
context, screenshot, framebuffer read or ROM copy is created. The final native
snapshot preserves dimensions from before Close releases the canvas. Native
output after Close is ignored by diagnostics and forwarded as before.

The reporting 2.13.0 log had 20 adapter reads, a frontend start notification,
no captured errors and no audio contexts. That does not identify the cause of
the black screen. A browser check using the actual pinned frontend `initModule`
and Azahar `callMain` with invalid synthetic content captured a native loader
failure despite a zero entry-point return code. This is diagnostic evidence
collection, not a verified fix for the reporting device's game. The original
save database, ROM mapping, core pin and renderer settings are unchanged.


## Encrypted 3DS load errors (2.13.2)

The pinned Azahar loader's exact critical message `Failed to determine system
mode (Error 8)!` means `Loader::ResultStatus::ErrorEncrypted`. Runtime support
surfaces it as `EncryptedRomError` / `Azahar.load` and the player displays a
localized, persistent notification explaining that compatible decrypted ROM
content is required. A later frontend start notification or visibility update
does not replace the error phase with running. Other native warnings remain
in diagnostics without triggering this encrypted-ROM notification. Lines
explicitly saying `This is not an error.` do not fill the retained issue list.

This mapping was checked against the Azahar loader enum, the core load error
switch, and the NCCH encryption flag check, and reproduced with a synthetic
NCCH header in the actual pinned binary. No commercial ROM was used in the
check. The application does not alter ROM bytes or clear encryption flags.
This improves error reporting; it does not make encrypted content loadable.

References:
- https://github.com/EmulatorJS/azahar/blob/master/src/core/loader/loader.h
- https://github.com/EmulatorJS/azahar/blob/master/src/core/core.cpp
- https://github.com/EmulatorJS/azahar/blob/master/src/core/file_sys/ncch_container.cpp


## Observe header flags without assuming payload status (2.13.3)

The Azahar ErrorEncrypted classification is established by the log, but the
user's ROM payload has not been independently examined. The notification now
reports the core classification and asks to check format/decryption status,
without asserting that the payload is known to be encrypted or prescribing a
replacement as the only established resolution.

Library range diagnostics record the actual loaded filename and structural
metadata from the already downloaded first 256 KiB. NCSD partition zero is
located using its little-endian media-unit offset and checked against the
object size. A recognized NCCH header records the raw flag byte at NCCH+0x18F
and its no-crypto bit (bit 2). Short/unknown/out-of-probe headers are reported
without guessing their flags. No additional fetch, payload copy or mutation
is performed for this inspection.

When a native file-system read spans that flag position, diagnostics observe
the byte in the buffer delivered to the caller, count checks and compare it
with the original probe. Any observed mismatch is retained. These values
verify this part of the byte-delivery path; they do not perform cryptographic
validation or independently establish the decryption state of the payload.
No raw header block, key, signature or payload bytes are exported. Local-only
ROM diagnostics retain their prior behavior; this probe inspection applies
to the library range path. The uploaded diagnostic log and original ROM are
not changed.

## Check the extended-header digest (2.13.4)

The library range probe now also compares the standard 0x400-byte NCCH
extended header at NCCH+0x200 with the SHA-256 digest at NCCH+0x160.
The declared length at NCCH+0x180 must be exactly 0x400. The inspection checks
object and partition bounds and uses only bytes already in the first probe.
It performs no extra network request and never changes the ROM or its flags.

Diagnostics retain `romIO.header.exheaderHash` after closing the player.
`state` is `match`, `mismatch`, or a specific reason the check could not run
(missing/unsupported header, invalid bounds, outside the probe, missing
digest, or unavailable Web Crypto). A failed diagnostic does not prevent
mounting. Only the algorithm, scope, result, and byte count are exported;
no raw bytes or digest values are included.

A match verifies only that the observed extended-header bytes agree with
the stored digest. It does not validate ExeFS, RomFS, the whole ROM, its
provenance, or game compatibility. A mismatch does not by itself distinguish
encryption, corruption, modification, or an incorrect stored digest. Neither
result triggers decryption or automatic flag normalization.

The SHA-256 comparison follows the exheader verification used by
[Project_CTR makerom](https://github.com/3DSGuy/Project_CTR/blob/master/makerom/src/ncch.c).

## Normalize verified plaintext headers for the pinned Azahar core (2.14.0)

The reporting library ROM has a matching plaintext exheader digest while its
NCCH no-crypto flag is unset. Azahar rejects that flag before loading the game.
The range adapter now checks additional content before creating a read-only
virtual correction. It never writes to R2, the uploaded file, or cached source
bytes, and it does not decrypt data or supply encryption keys.

The correction applies only to partition zero of a recognized NCSD, or a direct
NCCH, in the library range path, using NCCH version 2 and 512-byte media units.
The exheader must match its stored digest. The ExeFS superblock and every
populated file in the pinned core's eight-entry layout must also match their
stored SHA-256 digests, including a required `.code` entry. A present RomFS must
have a matching superblock digest. All declared bounds, overlaps and check
limits must pass. A normally marked no-crypto ROM needs no extra checks.

Successful checks set only bit 2 at NCCH+0x18F in returned read buffers.
Other flag bits and all source bytes remain intact. Partial, repeated, and
cross-block reads receive the same virtual value. Diagnostics record original
and virtual flags under `romIO.header.compatibility`, retained after Close.
The older comparison against the probe will intentionally differ after a
correction; `deliveredMatchesVirtual` and
`unexpectedDeliveryMismatchObserved` distinguish this from a transfer error.

Additional reads are asynchronous worker requests in 256 KiB blocks, using
the same exact ETag/206/Content-Range validation and 8 MiB LRU cache as playback.
Superblock checks are limited to 1 MiB each; individual ExeFS files to 32 MiB,
and combined ExeFS file checks to 64 MiB. Each file is hashed separately with
Web Crypto, so the temporary input buffer is at most 32 MiB, never the whole
ROM. Preparation is bounded to 60 seconds with a 6-second per-read deadline.
Close cancels the pending request and terminates its worker. Verification I/O
failure rejects mounting without falling back to a full download. A hash
mismatch, unsupported layout, unavailable digest, or exceeded check limit
leaves the flag untouched and records the reason.

This checks the executable files and selected RomFS metadata, not every byte
of RomFS, the authenticity of its unsigned hashes, or all NCSD partitions.
It does not prove overall ROM integrity or guarantee game compatibility.
Local-only lazy-file loading and other systems are unchanged. No save data
is cleared or migrated by this feature.

## Separate optional permission denial from ROM I/O failure (2.14.1)

The reporting 2.14.0 library log confirms matching exheader, ExeFS file and
RomFS superblock checks and delivery of the corrected flag. The core progresses
into game service calls. A stackless NotAllowedError then appears, followed
separately by a failed playback range at offset 3670016 and a native assertion.
The log does not identify which API rejected the permission request, whether
the failures are related, or why that range failed. Suspended audio and the
approximately 1.69 GiB WASM heap are observations, not independent proof of
autoplay denial or memory exhaustion.

The pinned core's wake-lock helper retains `navigator.wakeLock.request()`
without handling asynchronous rejection. Runtime support now attaches a
rejection observer while returning the original promise, preserving native
success/release behavior and synchronous exceptions. A denial is retained
under `operationFailures` as `navigator.wakeLock.request` with `optional: true`;
it does not produce a fatal notification. Other permission operations and
unidentified rejections retain their existing error behavior. This fixes a
known rejection-handling defect but does not retroactively identify the
stackless error in the uploaded log.

The reader worker now passes a bounded numeric failure code through shared
memory before signaling a failed synchronous read. `romIO.ioFailure` retains
the phase, transport, reason, failing offset/length and, where available, HTTP
status and wait duration after Close. Reasons distinguish HTTP status,
Content-Range/ETag/size/encoding validation, truncated or oversized bodies,
network errors, response/body timeouts and the main-side wait deadline.
Prefetch and probe failures also retain their reason. No response body,
request credential, URL query, or raw exception text is added to these logs.
The transport, deadlines and fail-closed validation rules are unchanged;
the underlying playback range failure still requires a reporting-device log.

## Prepare Safari library ROMs on disk before playback (2.15.0)

The 2.14.1 reporting-device log identifies a playback `response-timeout` after
4505 ms at offset 3670016. The wake-lock denial is separately named and handled
as optional. This establishes where reading fails, but does not establish why
the network response was delayed.

For remote library 3DS ROMs on the pinned frontend's Safari path, the adapter
now prepares an OPFS temporary copy after existing header/content verification
and before mounting the ROM. The native Start Game interaction is preserved.
The core may already be initialized while the copy is prepared. The entire ROM
must finish downloading before playback starts; this requires browser quota
and device space for the ROM. No file picker or persistent-storage permission
request is added. Local ROMs, other systems, and non-Safari range loading keep
their existing behavior.

The reader worker creates a uniquely named temporary file under its dedicated
`retrovault-rom-temp-v1` OPFS directory and holds a SyncAccessHandle. It reuses
the verified first probe, then requests at most 4 MiB per range. Every response
must have the exact 206/Content-Range/size/ETag and no Content-Encoding. Response
streams are written in at most 64 KiB write calls, handling partial writes.
No whole-ROM ArrayBuffer, Blob, or MEMFS file is created. The 8 MiB read cache
and per-file Web Crypto limits remain; network request buffers are bounded by
the 4 MiB range size. Preparation uses a 20-second response/body idle timeout,
with a 60-second parent-side progress watchdog, rather than a fixed timeout for
the complete large download.

After checking the stored file size and flushing, the adapter clears its read
cache and exposes `romIO.mode: "lazy-opfs"`. Worker playback reads use only the
synchronous disk handle. No ROM fetch occurs on a cache miss, and disk failure
does not fall back to network or a whole-ROM memory allocation. The existing
verified virtual no-crypto correction still applies only to returned buffers.
`romIO.disk` records progress, preparation state, and cleanup state; OPFS read
failures are marked with transport `OPFS`.

The progress overlay shows downloaded/total bytes and Cancel without moving
focus. Missing OPFS/SyncAccessHandle support, quota failure, or an incomplete
or changed download stops startup with an English/Japanese explanation. Cancel
and Close abort active requests, close the access handle, and remove the owned
temporary file. Player shutdown waits for cleanup alongside save flushing,
with a bounded 1800 ms worker-disposal deadline. Abrupt tab/process termination
can leave a partial copy; when Web Locks is available, the next preparation
serializes cleanup and creation, removing only matching files in the dedicated
temporary directory. Locked files belonging to active sessions are skipped.
Without Web Locks, stale automatic cleanup is skipped to avoid a creation race;
normal per-session cleanup still runs. Pending cleanup is recorded, not claimed
as a successful deletion. Saves, IndexedDB databases and unrelated OPFS entries
are never removed by this path.

Validation includes worker tests for bounded/partial writes, quota, unavailable
storage, changed objects, short bodies, cancellation and disk read failure;
adapter checks for deferred mounting and unchanged virtual flags; and real
Chromium OPFS checks with two concurrent 20 MiB copies, offline cache misses,
stale-file cleanup, and normal deletion. The actual pinned frontend/core FS was
also exercised with a synthetic container through the OPFS path, preserving
the correction and making no ROM network requests after preparation. This is
not a successful commercial-game boot or a Safari-device verification.

## Keep completed ROM copies and manage device downloads (2.16.0)

Completed Safari library copies now live in `retrovault-rom-cache-v1` rather
than being deleted on Close. Cache keys are SHA-256 of the source URL, exact
server ETag and size. Manifests contain only a schema, display filename, size
and ETag, and are written and flushed after the ROM has been fully written,
flushed, and size-checked. A partial ROM without a valid manifest cannot be
reused. Reuse also checks the cached size and compares its first 256 KiB with
the newly validated server probe. The existing content checks then read from
the cached file, preserving virtual header correction. Normal reuse downloads
only this small update probe, not the full ROM.

The URL/ETag/size identity changing requires a new download. A corrupt prefix
or wrong cached size invalidates that copy. The previous release's temporary
files have no identity manifest and cannot be trusted for migration; the first
2.16.0 use therefore needs one fresh download. Unlocked old temporary copies
are reclaimed during preparation. Completed cache entries survive releases
while their identity and schema remain valid. Browser quota policy or site-data
cleanup may still evict them, and a server check is required before reuse; this
is not an offline-first application. No persistent-storage permission is
requested. Older cache versions remain available for explicit removal.

The public `/pages/downloads.html` page, linked in the library header, shows
only ROM copies on this device with their size and completion state. It offers
individual and bulk removal. Deletion removes the ROM first and only then its
manifest. Active exclusive access handles prevent removal; another player of
the same cached version receives a named busy error rather than redownloading
or truncating an active file. Completed copies are retained on Close; incomplete
or cancelled copies are removed. Web Locks serialize cache operations when
available, with OPFS exclusive file handles providing the file-level lock.
No server files, save databases, or unrelated OPFS directories are deleted.

### Limits of the new crash evidence

The supplied 2.15.0 log shows a complete 1 GiB disk copy, 118 ROM reads, no
recorded I/O failure, no fatal JavaScript error, and a last phase of `running`
seven seconds after startup. It includes rendering/shader activity and a
WASM linear heap of 2077753344 bytes (about 1.94 GiB). A pending-read snapshot
is recorded before the read completes and is not itself proof of a failed read.
The log contains no Close activity or browser termination reason. It cannot
distinguish process termination, memory pressure, a GPU failure without an
event, or another unrecorded stop; memory exhaustion is not established.
The pinned JS runtime advertises a heap maximum of 4294901760 bytes, so the
observed value is not proof of a 2 GiB WASM maximum either.

The diagnostics wrapper no longer inserts RetroArch `-v` into normal startup.
The upstream Azahar libretro constructor separately sets its own Debug filter,
so removing `-v` alone does not disable core-generated Debug output. In normal
production mode these lines now only increment a bounded counter; they do not
rebuild retained log arrays or schedule diagnostic persistence. Errors and
critical lines are still captured, and explicit debug mode keeps detailed
capture. Heap-size changes are retained as up to eight timestamped samples.
These changes remove unnecessary diagnostic overhead, but do not establish or
guarantee a fix for the reporting-device crash or reduce the core's intrinsic
native allocations. A new device run is needed to assess the remaining stop.

Validation covers cache reuse, ETag and size changes, corrupted/truncated
entries, busy locks, cancellation, deletion scope, and production log filtering.
Real-browser tests verify reuse across navigation with exactly one probe,
offline reads after preparation, server-version refresh, protected active
deletion, and English/Japanese mobile cache management. The actual pinned
frontend/core filesystem still receives corrected virtual flags without
forced verbosity, using synthetic content only.
