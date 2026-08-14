# MicroPython & CircuitPython Language Server

Add autocomplete, inline docs, go to definition, and type checking for
Embedded Python projects using MicroPython or CircuitPython 🐍🤖.

Works on both desktop and web versions of VS Code, and compatible editors.

🚧 This extension is still under development. The BBC micro:bit and MicroPython
boards are implemented, CircuitPython will be added soon.

## Why this extension vs a generic Python LSP

The goal of this extension is to provide a language server specifically
configured for MicroPython and CircuitPython, so the completions and
signatures it offers are relevant to your embedded Python project.

Existing Python extensions expect to be running on the desktop or a server with
filesystem access, to scan installed packages for type information.
This extension is designed to run on both desktop and the browser version
VSCode web (https://vscode.dev, https://github.dev), and it ships with full
stubs for the most common MicroPython and CircuitPython boards, so what it
offers matches the board you are using.

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

**Board not listed?** Pick the generic target for its chip, shown in the dropdown as
`… (generic)`: `micropython/rp2` for any RP2040 or RP2350, `micropython/samd` for SAMD21 and
SAMD51, `micropython/stm32` for STM32. These are the port-wide stubs MicroPython publishes, so
they cover everything the port has in common and only miss the pin definitions specific to your
board. For ESP32 and ESP8266 the port-wide stubs are what `micropython/esp32/esp32_generic` and
`micropython/esp8266/esp8266_generic` already give you.

**One board at a time, never a merge.** The same module means different things on
different boards, `machine` most of all, so a combined set would offer you
hardware you do not have. Changing the target restarts the language server with
that board's modules and nothing else.

MicroPython boards are stubbed at **1.28**; the micro:bit at **v0.4.0** of the
Foundation's stubs. Older firmware gets slightly optimistic completions.

If you flashed **upstream MicroPython** onto a micro:bit rather than the
Foundation's build, pick `auto`, not `microbit`: your board has `machine` and
the standard library, and none of the `microbit`, `display` or `radio` modules
the `microbit` target offers.

🚧 CircuitPython boards are next.

## What gets analysed

**Your project's `.py` files are read directly.** Your own modules, and any
pure-Python files in the project folder, get full autocomplete with no stubs
needed, including files you have not opened.

**Stubs cover what isn't a file in your project.** The stubs for
MicroPython/CircuitPython built-in modules, like `machine`, `board`, etc are
included in the extension. Libraries present as compiled `.mpy` bytecode files
cannot be read, so they would need additional stubs to be provided alongside
your project to get autocomplete.

## Using it alongside other Python extensions

VS Code runs every Python language server installed and shows all of their
results combined.

As the generic Python extensions (like Microsoft's Pylance, Pyright, etc),
might contain invalid stubs for MicroPython/CircuitPython, it is recommended to
disable them for your project.

VS Code does not have a setting to pick a single language server, so each of the
others has to be switched off with its own settings.
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

On the other hand, you can disable this specialised MicroPython/CircuitPython
Python extension with this setting in your global or workspace settings:

```json
{
  "micropython-lsp.enable": false
}
```

## Licence

MIT, see [LICENSE](LICENSE).
Extension based on Microsoft's LSP web extension sample, MIT.
