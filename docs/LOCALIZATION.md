# Localization sources

The launcher and player use `assets/js/i18n.js`. Interface dictionaries are available for English (`en`) and Japanese (`ja`); the default selection mode is `auto`.

EmulatorJS native translations are based on these v4.2.3 source files:

- https://github.com/EmulatorJS/EmulatorJS/blob/v4.2.3/data/localization/en-US.json
- https://github.com/EmulatorJS/EmulatorJS/blob/v4.2.3/data/localization/ja-JA.json

The bundled native dictionary was modified for Retro Vault on 2026-10-28. It adds missing standard-interface strings, adjusts selected Japanese labels, and covers common NES/SNES core settings. EmulatorJS translations are distributed under GNU GPL version 3 or later; see `LICENSE-EmulatorJS.txt` in this directory.

Core option label references:

- https://github.com/libretro/libretro-fceumm/blob/master/src/drivers/libretro/libretro_core_options.h
- https://github.com/libretro/snes9x/blob/master/libretro/libretro_core_options.h

The player uses the locale identifier `ja-JA` expected by EmulatorJS 4.2.3. The loader receives a JSON object URL from the bundled dictionary. New native UI nodes and existing menu labels are localized without reloading the emulator. Matching changes display text and accessibility labels only; stored setting values are preserved.

Game titles, ROM filenames, product names, technical identifiers, and original license documents are not rewritten. Text rendered inside a game is part of the ROM and is not translated by the website.
