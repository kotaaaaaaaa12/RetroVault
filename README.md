# Retro Vault / EmulatorJS

A small JSON-driven EmulatorJS game library.

## Project layout

```text
EmulatorJS/
├── index.html
├── README.md
├── coi-sw.js
├── assets/
│   ├── css/
│   │   ├── style.css
│   │   └── player.css
│   └── js/
│       ├── app.js
│       ├── player.js
│       ├── i18n.js
│       ├── changelog.js
│       └── coi.js
├── data/
│   ├── games.json
│   ├── roms/
│   ├── thumbs/
│   └── bios/
├── pages/
│   ├── player.html
│   └── changelog.html
└── docs/
    └── CORE_REFERENCE.md
```

- `index.html` - game library UI entry point
- `assets/css/` - all stylesheets
- `assets/js/` - launcher, player and cross-origin-isolation scripts
- `pages/player.html` - isolated EmulatorJS iframe document
- `pages/changelog.html` - localized site release history, linked from the footer
- `data/games.json` - game database
- `data/roms/` - your legally obtained game files
- `data/thumbs/` - thumbnail files
- `data/bios/` - optional BIOS files you are allowed to use
- `docs/CORE_REFERENCE.md` - core/system reference
- `coi-sw.js` - kept at the project root intentionally so its Service Worker scope can cover the whole app

## games.json

Each game needs a unique positive integer `id`.

```json
{
  "id": 100,
  "title": "Example Game",
  "rom": "example.gba",
  "core": "gba",
  "thumbnail": "example.png"
}
```

Optional fields:

These fields are part of Retro Vault's own game database format. The player
reads them and sets the corresponding EmulatorJS options; EmulatorJS does not
read this JSON file itself. `ejsVersion` is already supported by
`resolveDataPath(game)` in `assets/js/player.js`.

```json
{
  "threads": true,
  "bios": "example-bios.bin",
  "gameParent": "extra-data.zip",
  "patch": "example.ips",
  "videoRotation": 0,
  "disableCue": false,
  "forceLegacyCores": false,
  "ejsVersion": "4.2.3",
  "dataPath": "https://example.com/emulatorjs/data/"
}
```

`threads` sets the threading policy for one game. Regular cores default to `false`; cores that require threads opt in automatically when the browser supports them. An explicit value overrides that default.

### Nintendo 3DS example

Add this object to the existing array in `data/games.json`. Use a unique ID:

```json
{
  "id": 301,
  "title": "Example 3DS Game",
  "rom": "example.3ds",
  "core": "3ds",
  "thumbnail": "example.png",
  "ejsVersion": "nightly"
}
```

Place the ROM at `data/roms/example.3ds` and the thumbnail at
`data/thumbs/example.png`. For database entries, explicitly set
`ejsVersion` to `nightly`; the local ROM picker adds that setting automatically.
The `3ds` and `azahar` core names are recognized by Retro Vault. Both require
threads, which the launcher enables when shared memory is available. Do not set
`threads` to `false` for these cores.

Data source precedence is `dataPath`, then a valid `ejsVersion`, then the pinned
default (`4.2.3`). Remove an old `dataPath` override if you want `ejsVersion` to
select the CDN version. Selecting the nightly loader is not a game compatibility
test; Nintendo 3DS gameplay on Safari has not been verified.

## Changelog

The footer links to `/pages/changelog.html`, which lists this site's cumulative
changes and follows the saved interface language. Add release entries there and
their translations in `assets/js/i18n.js` when shipping another update. Retro
Vault release identifiers are separate from EmulatorJS version numbers.

## Local ROMs

Use **OPEN LOCAL ROM** to choose a ROM from the device. The selected file is passed directly to the isolated player as a local `blob:` URL; it is not uploaded to the server.

The launcher auto-selects a system when the extension is distinctive, for example:

- `.nes` / `.fds` -> NES
- `.sfc` / `.smc` -> SNES
- `.gb` / `.gbc` -> Game Boy / Game Boy Color
- `.gba` -> Game Boy Advance
- `.z64` / `.n64` / `.v64` -> Nintendo 64
- `.nds` -> Nintendo DS
- `.md` / `.gen` / `.smd` -> Mega Drive / Genesis
- `.sms` -> Master System
- `.gg` -> Game Gear
- `.32x` -> Sega 32X
- `.a26` / `.a52` / `.a78` -> Atari 2600 / 5200 / 7800
- `.pce` -> PC Engine
- `.ngp` / `.ngc` -> Neo Geo Pocket
- `.ws` / `.wsc` -> WonderSwan
- `.adf` / `.adz` / `.ipf` -> Amiga
- `.wad` -> Doom / PrBoom
- `.3ds` / `.cci` / `.cia` -> Nintendo 3DS nightly

Ambiguous archive/disc extensions such as `.bin`, `.cue`, `.iso`, `.chd`, `.zip`, `.7z`, `.rar`, `.rom`, `.dsk` and `.pbp` intentionally show the system picker instead of guessing.

Multi-file disc games can still require a BIOS and/or a packaged disc set. A single local `.cue` file cannot magically include track files that were not selected.

## Threads

The launcher has no Threads switch or thread status labels. NES, SNES, and other regular cores start with threads disabled, regardless of the old site preference. Existing per-game EmulatorJS thread overrides are removed before launch without changing saves, controls, cheats, or other settings. The emulator's own settings menu remains available.

PSP, DOSBox Pure, and experimental 3DS cores opt in only because this project treats them as threaded-only. An explicit `threads` field in `games.json` overrides that policy. Unsupported browsers show an error for those cores instead of silently trying an incompatible mode.

Threaded cores still require cross-origin isolation. Cloudflare Pages should send these headers directly:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

PSP requires Threads. DOSBox Pure and experimental 3DS builds should also be treated as threaded-only in this project.

## EmulatorJS version

The default EmulatorJS data path is pinned to `4.2.3` instead of the moving `stable` channel. This avoids an unrelated future release silently changing the site.

A game can explicitly select another EmulatorJS version with `ejsVersion`, for example `latest` or `nightly`. Use moving channels only when you intentionally accept breaking changes.

## Supported system names

The UI recognizes the common EmulatorJS aliases and many explicit core names, including:

- Nintendo: NES, SNES, Game Boy, Game Boy Color, Game Boy Advance, Virtual Boy, Nintendo 64, Nintendo DS
- Sony: PlayStation, PSP
- Sega: Mega Drive / Genesis, Master System, Game Gear, Sega CD, 32X, Saturn
- Atari: 2600, 5200, 7800, Lynx, Jaguar
- Arcade: Arcade / FBNeo, MAME 2003
- NEC / SNK / Bandai: PC Engine, PC-FX, Neo Geo Pocket, WonderSwan
- Other consoles: 3DO, ColecoVision
- Commodore: C64, C128, VIC-20, Plus/4, PET, Amiga
- DOSBox Pure
- Extra cores exposed by the pinned core set: ZX81, ZX Spectrum, Amstrad CPC, Doom / PrBoom and Philips CD-i

Nintendo 3DS appears in the current upstream demo but is not part of the pinned `4.2.3` stable core set. If you intentionally test it, use an appropriate newer channel such as `nightly` per game.

## Why the iframe exists

EmulatorJS mutates the document and owns long-lived resources such as WebAssembly, audio, input listeners and animation loops. Every game is therefore launched inside `pages/player.html`. Closing the modal navigates that iframe to `about:blank`, tearing down the entire emulator document before another game starts.


## Legacy layout compatibility

The app prefers `data/games.json`, `data/roms/`, and `data/thumbs/`. It also automatically falls back to the original root-level `games.json`, `roms/`, and `thumbs/` paths, so the site keeps working while files are being reorganized.

## Cloudflare Pages

This build is ready for Cloudflare Pages. `_headers` is included at the deploy root and enables the COOP/COEP headers required for SharedArrayBuffer/Threads.

The previous automatic COI Service Worker bootstrap has been removed. Cloudflare Pages should provide cross-origin isolation directly through response headers, avoiding first-load reload loops and Safari/iPad Service Worker edge cases.

Deploy the *contents* of this directory as the Pages output root so that `index.html` and `_headers` are both at `/`.


## Cloudflare Pages deployment root

The Pages output directory must be the directory containing `index.html`, `_headers`, `assets/`, `data/`, and `pages/`. Do not publish the parent directory. This build includes a visible boot probe: if JavaScript fails, `LOADING RETRO VAULT…` remains visible instead of a blank page.

## Cloudflare Pages v3 diagnostics

- `_redirects` routes application paths to `/index.html`.
- `version.txt` identifies this deployment as `retro-vault-cloudflare-v3-20260901`.
- `index.html` unregisters legacy `coi-sw.js` service workers left by older builds.
- Threads should come from the `_headers` COOP/COEP response headers, not from a service worker.

## Player stability update: 2026-10-28

- Removed the launcher Threads switch, status observer, and old site preference.
- Direct player URLs default to threads disabled unless `threads=1` is supplied.
- Only the launcher CLOSE button dismisses the player. Backdrop clicks, Escape, and generic emulator exit messages no longer return to the game list.
- Emulator errors, unhandled exceptions, and WebGL context loss are shown inside the player. EmulatorJS 4.2.3's actual exit event is observed as well as compatibility callbacks.
- A session marker reports a page reload during a game. Browser process termination cannot be prevented or diagnosed from JavaScript alone.
- Updated asset versions so browsers request the changed JavaScript and stylesheets.

To apply the overlay, extract its contents into the existing repository root and overwrite matching files. ROMs, thumbnails, BIOS files, and games.json are not included or changed. Deploy through the existing Cloudflare Pages workflow. This update does not require a build command.

## Internationalization update: 2026-10-28

This cumulative overlay includes every file and behavior from the previous threading and player-stability overlay.

- The launcher language control provides Auto, English, and Japanese. Auto uses the browser's preferred language. The selected mode is saved on the device.
- Static text, accessibility labels, system names, search, filters, local-ROM selection, counters, startup errors, runtime errors, and reload notices use shared message dictionaries.
- Language changes update the launcher and active player without restarting a running game. Filters and local-ROM system selections are retained.
- EmulatorJS 4.2.3 calls its Japanese locale `ja-JA`, not `ja-JP`. The player now uses the correct identifier and supplies the complete bundled dictionary through an object URL. No additional translation service is used.
- The native dictionary extends the upstream Japanese translations with missing standard menu labels and common FCEUmm/Snes9x core settings. Game titles, technical names, original license text, and text drawn by ROMs remain their original content.
- Unknown JavaScript failures show translated guidance; their original technical messages remain in the developer console.
- Japanese controls use a system font and adjusted sizing. The language selector releases pointer focus after selection.

Apply this ZIP directly over the repository root; the previous ZIP does not need to be applied separately. Existing ROM, BIOS, thumbnail, and game database files are not replaced. Then redeploy through the existing Cloudflare Pages setup.

Run the regression checks with `node --test tests/player-stability.test.mjs`. These checks validate locale selection, native dictionary delivery, live switching, and the retained threading and player-close behavior. They do not constitute a Safari device playback test.

## Memory and lifecycle update: 2026-10-28

This cumulative overlay retains the complete threading, player-stability, and internationalization updates.

- Production mode replaces the always-on EmulatorJS debug setting. EmulatorJS 4.2.3 enables its core cache in this mode and avoids verbose runtime logging.
- The game library, thumbnails, header animations, and footer are hidden while a game is open. The active player uses an opaque background without backdrop blur or wrapper shadows.
- Closing uses a bounded stop handshake. The player pauses the core, requests SRAM saving, waits briefly for filesystem persistence, closes known audio contexts, reduces the canvas to 1 x 1, disconnects its translation observer, clears its timers, and revokes owned object URLs. The launcher then unloads the iframe. A stalled player cannot block closing indefinitely.
- The shutdown path avoids calling a nonexistent `emulator.exit()` method and prevents the native beforeunload path from resetting an already-stopped core. This does not delete save data or disable normal save features.
- A backgrounded game is paused and resumes when visible again; a game that was paused manually remains paused.
- Local-ROM File references are released after the core starts. Runtime translation reuses its dictionary lookup entries and does not traverse an entire subtree for an attribute-only mutation.
- A bounded diagnostic record samples the core's WebAssembly heap length every 10 seconds. It never copies the heap or captures game frames. The latest session record remains in sessionStorage after a reload, subject to the browser's storage behavior.
- After a session, the footer offers **Save diagnostic log**. If Safari reloads the page again, save this JSON before starting another game; a new session replaces the previous record. The log includes game/core metadata, browser user agent, last sampled WebAssembly heap size and growth count, lifecycle phase, and up to four recent errors. Nothing is uploaded automatically.
- The EmulatorJS footer credit links to https://emulatorjs.org/ in a new tab.

The recorded heap size is only the core's WebAssembly linear memory. It does not measure total Safari memory, JavaScript allocations, audio allocations, compositor memory, or GPU memory. A Safari process termination can prevent JavaScript from receiving an error or writing a final sample. See `docs/MEMORY-NOTES.md` for the investigation, sources, and limits.
