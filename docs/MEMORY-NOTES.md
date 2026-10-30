# Memory and lifecycle investigation

Reviewed on 2026-10-28. This is a source review and a set of mitigations; it is not a device-level measurement of the reported Safari reload.

## Local 3DS startup report (2026-10-29)

The supplied v25 Safari log reports `Load failed`, followed by `Network Error`,
before any game-start event. Threads and cross-origin isolation were enabled.
The core reported a 512 MiB linear heap without recorded growth. The log does
not contain the failing URL or ROM size, and cannot establish a memory failure,
a corrupt ROM, a missing core resource, or a failed local file read.

The launcher previously passed a local `blob:` URL. The pinned 4.3.0-pre
frontend routes non-HTTP URLs through `fetch()`, while its named `File` path
reads the file directly and preserves the filename. Local launches now use that
File path, as in the official demo. This removes the blob-fetch step but does
not prove the reporting 3DS game will start on Safari.

Request diagnostics record up to 12 recent fetch requests, response status or
failure, and duration. URL credentials, query strings, fragments, and blob/data
contents are omitted. A response entry describes received headers, not completed
body consumption. Local file diagnostics record size, extension, and the native
`arrayBuffer()` read outcome without pre-reading or copying the ROM. Hooks are
restored on shutdown. No commercial ROM was used for local regression checks.

Sources:
- https://github.com/EmulatorJS/EmulatorJS/blob/main/index.html
- https://cdn.emulatorjs.org/4.3.0-pre/data/emulator.min.js

## Mobile startup failure and input report

A supplied 4.3.0-pre diagnostic recorded a TypeError reading
`Module.AL.currentCtx.sources`, followed 13 ms later by a stackless
`NotAllowedError`. Audio remained suspended. The core heap was 128 MiB with no
recorded heap growth; that does not measure or rule out total process memory
pressure. The reported failure concerned on-screen touch controls.

The pinned frontend's mobile Safari `checkStarted()` reads `currentCtx.sources`
without checking for null. Its OpenAL-only polling can also remain suspended
without usable sources. The compatibility helper replaces this check only for
mobile Safari detection and runtime version 4.3.0-pre. It does not change the
core or invent an OpenAL context for an RWebAudio backend. Existing audio contexts
are resumed only within a trusted gesture, without consuming that gesture or
creating an audio-wait popup. A manual pause is respected.

The original stackless permission failure cannot be attributed to a particular
API from the supplied log. New named operation records cover AudioContext.resume,
gamepad enumeration, fullscreen, pointer lock, and requested microphone access.
Calls retain their return values and errors. The diagnostic records aggregate
pointer, touch, virtual-control, keyboard, and simulateInput call counts, plus
native popup state and an available player-one device ID. It records no key
values or control text. Counters and failure lists are bounded; hooks restore
on player shutdown. A simulateInput call count proves a call reached that method,
not that the core accepted the input.

The uploaded log did not identify why on-screen controls were unresponsive.
Regression tests exercise the null-context failure and gesture/input forwarding;
recovery on the reporting iPhone browser still requires a device test.

Source: https://github.com/EmulatorJS/EmulatorJS/blob/v4.3.0-pre/data/src/emulator.js

## Confirmed in the previous overlay

1. `EJS_DEBUG_XX` was always true. In EmulatorJS v4.2.3, the core cache read is guarded by `!this.debug`. Debug mode also uses separate source scripts and verbose runtime logs. Production mode restores that cache path; this establishes unnecessary work, not the cause of a Safari termination.
2. A full-screen player backdrop used blur while the game library remained rendered behind it. The header also retained an infinite animation. These effects are unnecessary during gameplay. The library is now hidden and the player backdrop is opaque, without blur.
3. Cleanup attempted `window.EJS_emulator.exit()`, but the pinned EmulatorJS implementation does not expose that method. Cleanup now uses the available pause and filesystem interfaces before iframe teardown.
4. Native EmulatorJS v4.2.3 has an exit handler in GameManager that saves, restarts, saves again, and aborts later. Its beforeunload listener emits exit while `started` is true. The new explicit shutdown first pauses and requests persistence, then clears `started` so navigation does not trigger that reset path again.
5. The launcher's selected local File remained referenced for the entire session. It is now released only after the core reports that the game has started.
6. The translation function recreated `Object.entries(nativeJa)` for unmatched text. Entries are now prepared once. Attribute-only mutations no longer trigger recursive localization of the entire target subtree. These changes reduce allocation and traversal work; no measured memory saving is claimed.

## Relevant upstream reports

- https://github.com/EmulatorJS/EmulatorJS/issues/1143 contains reports of automatic Safari reloads on iPhone and iPad. The discussion includes WebAssembly memory-growth and audio-backend observations. Those are upstream reports and hypotheses, not a proven diagnosis of this installation.
- https://github.com/EmulatorJS/EmulatorJS/issues/1220 reports an iPhone WebContent termination after continuous play; a maintainer identifies it as a duplicate of #1143. Its author reports native/GPU/compositor memory behavior, which a WebAssembly heap reading alone cannot prove or exclude.

Pinned source references:

- https://github.com/EmulatorJS/EmulatorJS/blob/v4.2.3/data/src/emulator.js
- https://github.com/EmulatorJS/EmulatorJS/blob/v4.2.3/data/src/GameManager.js
- https://github.com/EmulatorJS/EmulatorJS/blob/v4.2.3/data/loader.js

## Periodic save write review

`GameManager.mountFileSystems()` mounts `/data/saves` using IDBFS with
`autoPersist: true`. The save manager added in the earlier overlay also called
`FS.syncfs(false)` after every native `saveSaveFiles` event. That duplicated
the persistence work and caused hidden slot controls to be rebuilt on each
completion. The native save listener now only records a small activity marker.
Manual save and close operations retain their explicit flush and confirmation.
Native automatic saving remains enabled with the same initial 30-second
interval. Confirmed timestamps refer to completed manual/closing flushes.

This is a confirmed redundant operation in the integration, not proof that it
caused the reported Safari reload. Upstream #1143 also includes a report of
reloads with save intervals disabled. The core, WebKit, and integration cannot
be distinguished from the symptom alone.

## Diagnostics and limits

The latest session diagnostic is sampled every 10 seconds, on phase changes, and on captured errors. Only numeric heap length and small metadata are serialized. Errors are deduplicated and limited to the latest four entries, with bounded message lengths. The diagnostic download is local; it does not contact a logging service.

The startup diagnostic update adds capped error names, stacks, source locations,
and an environment snapshot for each captured error. It retains at most three
relevant console warnings/errors, including internally handled exceptions.
Console output is forwarded unchanged and the temporary hooks are restored on
shutdown. The launcher accepts diagnostic records up to 32,000 characters. No
memory buffer, screenshot, or save-state data is included in these records.

Reload diagnostics now also include the time since the actual game-start event,
a native save-event counter, and at most eight recent activity markers. They
record the last observation before a reload and do not identify the OS's reason
for terminating a process. Sampling stays at ten seconds and uses no extra
graphics/audio contexts or save-state captures. The last timing may therefore
precede the actual reload by several seconds.

User activation, document visibility, existing audio context states, and
supported permission-policy flags are read without requesting permissions or
opening extra audio or graphics contexts. These fields describe conditions;
they do not prove that a particular API caused the failure. Safari's exact
`Permission was denied` report is not attributed to audio, storage, or any
other subsystem without a matching stack or call-site trace.

Automatic startup is disabled. The user taps the native Start Game button in
the emulator document, in line with the official `EJS_startOnLoaded` warning:
https://emulatorjs.org/docs/options/#ejs_startonloaded
This is a mitigation for the known user-interaction requirement, not a verified
fix for the reported device failure. Existing saves are not cleared.

`wasmHeapBytes` and `peakWasmHeapBytes` represent WebAssembly linear memory only. They exclude JavaScript, browser processes, audio, decoded thumbnails, canvas backing stores, GPU allocations, and other tabs. A flat heap therefore cannot establish that total memory is stable. Safari's own tab notification is outside the document and cannot be captured by the site's error listeners.

If the page reloads, save the footer diagnostic JSON before starting another game. A new game replaces the previous session record. A manual close may record `saveFlush` as `saved`, `failed`, `timed-out`, or `not-needed`; the timeout is a recovery path, not a guarantee that a stalled core's latest SRAM reached storage.

The native core memory configuration is unchanged. No arbitrary WebAssembly heap cap, forced core switch, periodic game reset, or save-state restart loop was added. The mitigation does not establish that Safari's underlying issue is fixed.


## Standalone comparison result and next release comparison

The submitted v10 standalone NES report records 64 seconds since game start,
128 MiB current and peak WebAssembly memory, no captured JavaScript errors, and
`framed: false`. The user reports the same reload symptom. This page did not
load the launcher, player wrapper, or additional save manager and retained the
native save interval default. Those integrations are therefore not required to
reproduce the observed symptom. This does not identify the browser's termination
reason, prove total memory exhaustion, or eliminate all shared code and settings.

The v11 comparison offers pinned 4.3.0-pre as well as 4.2.3. Upstream's official
4.3.0-pre notes describe the audio driver change and disabling async for most
cores. The normal player is not upgraded by this change. Full matching loaders
and cores are selected together and test save names are separated by release.
The prerelease condition has not been played on a Safari device here and must
not be presented as a confirmed fix. No site data or normal saves are cleared.


## Main player update to 4.3.0-pre

The later submitted v11 standalone report selected and reported runtime version
4.3.0-pre, resolved `fceumm`, and reached a last game-elapsed sample of 325 seconds
with 128 MiB current/peak WASM memory and no captured errors. The user reports
that the reload stopped. This is evidence for that session and test configuration,
not a verified root cause or proof across all cores.

At the user's request v12 changes the main player's pinned default to that same
release. The matching loader, modules, and cores share one versioned data path.
Per-game overrides and legacy locale contracts remain supported. The main player
still includes its save manager and iframe lifecycle, so its updated Safari
integration needs device playback verification.

The new RWebAudio context is private in upstream's JS library. A proxy around
existing AudioContext constructors in the player iframe records contexts that
the runtime creates; it does not create a context or request permission. Those
contexts are included in bounded state diagnostics and deduplicated with legacy
OpenAL contexts for explicit shutdown. Native constructors are restored on close.
The existing pause, save-flush timeout, canvas release, and iframe teardown remain.

Official source references:
- https://github.com/EmulatorJS/EmulatorJS/releases/tag/v4.3.0-pre
- https://github.com/EmulatorJS/EmulatorJS/blob/v4.3.0-pre/data/loader.js
- https://github.com/EmulatorJS/EmulatorJS/blob/v4.3.0-pre/data/src/GameManager.js
- https://github.com/EmulatorJS/RetroArch/blob/v1.22.2/emscripten/library_rwebaudio.js

No FPS limit or gameplay-speed adjustment was added. The uploaded test log did
not record measured frame rate. Original NTSC NES Mario normally runs near 60 fps;
its TIME counter is not a real-seconds clock. The existing native speed controls
remain available.

## Bounded local reads (2026-10-30)

The v27 report trimmed 4 GiB to 3,307,900,928 bytes, then ended during
File.arrayBuffer(). The user confirmed a Safari reload. The log establishes
the pending whole-file read, not the browser termination reason.

Large plain local 3DS/CCI/CXI/APP/ELF/AXF files now bypass that frontend path on
the pinned Azahar runtime. A dedicated worker uses FileReaderSync on 1 MiB
slices, returning bytes through a shared buffer. A read-only FS adapter has an
8 MiB LRU cache and bounds temporary copies. The synchronous core waits for
uncached blocks with a five-second limit; this can block the UI during IO.
This is a custom adapter, not WORKERFS. Worker initialization has a ten-second
timeout and unsupported environments do not fall back to allocating the ROM.

Validation uses the actual pinned Azahar JS/Wasm distribution and a sparse
4 GiB synthetic file. FS reads at the start, beyond 2 GiB, and the end match
expected bytes, with a 512 MiB core heap and cache bounded at 8 MiB. The adapter
frontend handoff and cleanup are also checked. This is not a commercial-game
boot test or Safari device test; core-internal allocations and gameplay
performance remain unverified.

## Library range path (2.11.0)

The submitted 2.10.1 library log requested the R2-backed 3DS URL successfully
but did not record a game start. Its `loading-core` phase was stale across ROM
loading. The user separately reports that the small 2048 ELF starts successfully.
These observations do not prove that memory exhaustion caused the reload.

The library path previously buffered all download chunks and assembled an
ArrayBuffer. The new worker fetches verified 256 KiB ranges with an 8 MiB LRU
cache and pins ETag/total size across requests. It rejects unbounded HTTP 200,
short or oversized bodies, changed objects, and invalid Content-Range values.
There is no full-file fallback. Network stalls can block synchronous core reads
for up to five seconds; this implementation does not establish Safari game
compatibility or bound memory allocated internally by the core.

Validation used the actual pinned Azahar FS and a synthetic 4 GiB HTTP object,
checking initial bytes, a block boundary, offsets above 2 GiB, and the final 256
bytes. The measured cache stayed at 8 MiB with a 256 KiB maximum fetch; a server
returning HTTP 200 was rejected without invoking the frontend full-file path.
This is an FS/network integration check, not a commercial-game or Safari boot.
