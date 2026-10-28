export const DEFAULT_VERSION = "4.3.0-pre";
export const SYSTEMS = [
  {
    "id": "atari5200",
    "label": "Atari 5200",
    "cores": [
      "a5200"
    ]
  },
  {
    "id": "vb",
    "label": "Virtual Boy",
    "cores": [
      "beetle_vb"
    ]
  },
  {
    "id": "nds",
    "label": "Nintendo DS",
    "cores": [
      "melonds",
      "desmume",
      "desmume2015"
    ]
  },
  {
    "id": "arcade",
    "label": "Arcade",
    "cores": [
      "fbneo",
      "fbalpha2012_cps1",
      "fbalpha2012_cps2",
      "same_cdi"
    ]
  },
  {
    "id": "nes",
    "label": "NES / Famicom",
    "cores": [
      "fceumm",
      "nestopia"
    ]
  },
  {
    "id": "gb",
    "label": "Game Boy / Game Boy Color",
    "cores": [
      "gambatte"
    ]
  },
  {
    "id": "coleco",
    "label": "ColecoVision",
    "cores": [
      "gearcoleco"
    ]
  },
  {
    "id": "segaMS",
    "label": "Master System",
    "cores": [
      "smsplus",
      "genesis_plus_gx",
      "genesis_plus_gx_wide",
      "picodrive"
    ]
  },
  {
    "id": "segaMD",
    "label": "Mega Drive / Genesis",
    "cores": [
      "genesis_plus_gx",
      "genesis_plus_gx_wide",
      "picodrive"
    ]
  },
  {
    "id": "segaGG",
    "label": "Game Gear",
    "cores": [
      "genesis_plus_gx",
      "genesis_plus_gx_wide"
    ]
  },
  {
    "id": "segaCD",
    "label": "Sega CD / Mega CD",
    "cores": [
      "genesis_plus_gx",
      "genesis_plus_gx_wide",
      "picodrive"
    ]
  },
  {
    "id": "sega32x",
    "label": "Sega 32X",
    "cores": [
      "picodrive"
    ]
  },
  {
    "id": "sega",
    "label": "sega",
    "cores": [
      "genesis_plus_gx",
      "genesis_plus_gx_wide",
      "picodrive"
    ]
  },
  {
    "id": "lynx",
    "label": "Atari Lynx",
    "cores": [
      "handy"
    ]
  },
  {
    "id": "mame",
    "label": "MAME",
    "cores": [
      "mame2003_plus",
      "mame2003"
    ]
  },
  {
    "id": "ngp",
    "label": "Neo Geo Pocket / Color",
    "cores": [
      "mednafen_ngp"
    ]
  },
  {
    "id": "pce",
    "label": "PC Engine / TurboGrafx-16",
    "cores": [
      "mednafen_pce"
    ]
  },
  {
    "id": "pcfx",
    "label": "PC-FX",
    "cores": [
      "mednafen_pcfx"
    ]
  },
  {
    "id": "psx",
    "label": "PlayStation",
    "cores": [
      "pcsx_rearmed",
      "mednafen_psx_hw"
    ]
  },
  {
    "id": "ws",
    "label": "WonderSwan / Color",
    "cores": [
      "mednafen_wswan"
    ]
  },
  {
    "id": "gba",
    "label": "Game Boy Advance",
    "cores": [
      "mgba"
    ]
  },
  {
    "id": "n64",
    "label": "Nintendo 64",
    "cores": [
      "mupen64plus_next",
      "parallel_n64"
    ]
  },
  {
    "id": "3do",
    "label": "3DO",
    "cores": [
      "opera"
    ]
  },
  {
    "id": "psp",
    "label": "PlayStation Portable",
    "cores": [
      "ppsspp"
    ]
  },
  {
    "id": "atari7800",
    "label": "Atari 7800",
    "cores": [
      "prosystem"
    ]
  },
  {
    "id": "snes",
    "label": "SNES / Super Famicom",
    "cores": [
      "snes9x",
      "bsnes"
    ]
  },
  {
    "id": "atari2600",
    "label": "Atari 2600",
    "cores": [
      "stella2014"
    ]
  },
  {
    "id": "jaguar",
    "label": "Atari Jaguar",
    "cores": [
      "virtualjaguar"
    ]
  },
  {
    "id": "segaSaturn",
    "label": "Sega Saturn",
    "cores": [
      "yabause"
    ]
  },
  {
    "id": "amiga",
    "label": "Commodore Amiga",
    "cores": [
      "puae"
    ]
  },
  {
    "id": "c64",
    "label": "Commodore 64",
    "cores": [
      "vice_x64sc"
    ]
  },
  {
    "id": "c128",
    "label": "Commodore 128",
    "cores": [
      "vice_x128"
    ]
  },
  {
    "id": "pet",
    "label": "Commodore PET",
    "cores": [
      "vice_xpet"
    ]
  },
  {
    "id": "plus4",
    "label": "Commodore Plus/4",
    "cores": [
      "vice_xplus4"
    ]
  },
  {
    "id": "vic20",
    "label": "Commodore VIC-20",
    "cores": [
      "vice_xvic"
    ]
  },
  {
    "id": "dos",
    "label": "DOSBox Pure",
    "cores": [
      "dosbox_pure"
    ]
  },
  {
    "id": "intv",
    "label": "intv",
    "cores": [
      "freeintv"
    ]
  },
  {
    "id": "3ds",
    "label": "Nintendo 3DS",
    "cores": [
      "azahar"
    ]
  }
];
export function systemFor(core) { return SYSTEMS.find(item => item.id === core || item.cores.includes(core)); }
export function detectSystem(filename) { const ext = filename.toLowerCase().split(".").pop(); const map = { nes:"nes",fds:"nes",sfc:"snes",smc:"snes",gb:"gb",gbc:"gb",gba:"gba",nds:"nds","3ds":"3ds",cci:"3ds",cia:"3ds",n64:"n64",z64:"n64",v64:"n64",sms:"segaMS",gg:"segaGG",md:"segaMD",gen:"segaMD",pce:"pce",ws:"ws",wsc:"ws",a26:"atari2600",a78:"atari7800",lnx:"lynx",ngp:"ngp",ngc:"ngp" }; return map[ext] || null; }
