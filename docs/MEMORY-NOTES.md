# Memory and lifecycle investigation

Reviewed on 2026-10-28. This is a source review and a set of mitigations; it is not a device-level measurement of the reported Safari reload.

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

## Diagnostics and limits

The latest session diagnostic is sampled every 10 seconds, on phase changes, and on captured errors. Only numeric heap length and small metadata are serialized. Errors are deduplicated and limited to the latest four entries, with bounded message lengths. The diagnostic download is local; it does not contact a logging service.

The startup diagnostic update adds capped error names, stacks, source locations,
and an environment snapshot for each captured error. It retains at most three
relevant console warnings/errors, including internally handled exceptions.
Console output is forwarded unchanged and the temporary hooks are restored on
shutdown. The launcher accepts diagnostic records up to 32,000 characters. No
memory buffer, screenshot, or save-state data is included in these records.

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
