# MicroPython & CircuitPython Language Server

Add autocomplete, inline docs, go to definition, and type checking for
Embedded Python projects using MicroPython or CircuitPython 🐍🤖.

Works on both desktop and web versions of VS Code, and compatible editors.

🚧 This extension is still under development. The BBC micro:bit, MicroPython and
CircuitPython boards are implemented.

## Why this extension vs a generic Python LSP

The goal of this extension is to provide a language server specifically
configured for MicroPython and CircuitPython, so the completions and
signatures it offers are relevant to your embedded Python project.

Existing Python extensions expect to be running on the desktop or a server with
filesystem access, to scan installed packages for type information.
This extension is designed to run on both desktop and the browser based
VSCode web (https://vscode.dev, https://github.dev), and it ships with full
stubs for the most common MicroPython and CircuitPython boards.

Stubs come from the [MicroPython-Stubs](https://github.com/Josverl/micropython-stubs)
and [CircuitPython](https://github.com/adafruit/circuitpython) projects.

## Supported boards

Pick your board from the **MicroPython & CircuitPython Language Server > Target**
dropdown in Settings, or add it to your workspace settings
(`.vscode/settings.json`):

```json
{
  "micropython-lsp.target": "micropython/rp2/rpi_pico_w"
}
```

| Target | Boards |
|---|---|
| `auto` (the default) | none. The MicroPython standard library alone, so `sys` resolves and `machine` does not |
| `microbit` | BBC micro:bit, running the micro:bit's version of MicroPython (with the `microbit` module) |
| `micropython/esp32/…` | ESP32, and the C3, C5, C6, S2 and S3 variants |
| `micropython/esp8266/...` | ESP8266 versions |
| `micropython/rp2/…` | RP2040 and RP2350 boards like Raspberry Pi Pico, Pico W, Pico 2, Pico 2 W, Arduino Nano RP2040 Connect, Waveshare RP2040-Zero |
| `micropython/samd/...` | Microchip SAMD boards like the Seeed Wio Terminal |
| `micropython/stm32/pybv11` | PyBoard v1.1 |
| `circuitpython/…` | 628 CircuitPython boards, one entry each, as: `circuitpython/raspberry_pi_pico_w`, `circuitpython/adafruit_feather_esp32s2`, etc |

## What gets analysed

**Your project's `.py` files are read directly.** Your own modules, and any
pure-Python files in the project folder, get full autocomplete with no stubs
needed, including files you have not opened.

**Stubs cover what isn't a file in your project.** The stubs for
MicroPython/CircuitPython built-in modules, like `machine`, `board`, etc are
included in the extension.

Libraries present in your project as compiled `.mpy` bytecode files
cannot be read, so they would need additional stubs to be provided alongside
them to get autocomplete.

## Using it alongside other Python extensions

VS Code runs all the Python language servers installed simultaneously and shows
their results combined.

As the generic Python extensions (like Microsoft's Pylance, Pyright, etc),
might contain invalid stubs for MicroPython/CircuitPython, it is recommended to
disable them for your project.

VS Code does not have a setting to pick a single language server, so each of the
others has to be switched off individually.
To disable the most common Python extensions, add this to your project's
`.vscode/settings.json` file:

```jsonc
{
  // Microsoft Python extension (Pylance, Jedi)
  "python.languageServer": "None",
  // Microsoft Pyright
  "pyright.disableLanguageServices": true,
  "python.analysis.ignore": ["**"],
  // basedpyright
  "basedpyright.disableLanguageServices": true,
  "basedpyright.analysis.ignore": ["**"],
  // Astral ty
  "ty.disableLanguageServices": true,
  // Meta Pyrefly
  "python.pyrefly.disableLanguageServices": true,
  "python.pyrefly.disableTypeErrors": true
}
```

You can also enable/disable this specialised MicroPython/CircuitPython
Python extension with this setting in your global or workspace settings:

```json
{
  "micropython-lsp.enable": false
}
```

## Licence

MIT, see [LICENSE](LICENSE).
Extension based on Microsoft's LSP web extension sample, MIT.
