# MicroPython & CircuitPython IntelliSense LSP

Add autocomplete, type checking and inline docs for MicroPython and CircuitPython.
Works on VSCode web, and compatible editors, in the browser.

## Why this extension vs a generic Python LSP

The goal of this extension is to provide a language server specifically configured
for MicroPython and CircuitPython, so the autocomplete and type checking provided
is relevant to your embedded Python project.

Existing Python extensions expect to be running on the desktop or a server with
filesystem access, to scan installed packages for type information.
This extension is designed to run on both desktop and browser versions of
VSCode web (https://vscode.dev, https://github.dev), and it ships with stubs
for the most common MicroPython and CircuitPython boards, to provide the
relevant autocomplete and type checking.

Stubs come from the [MicroPython-Stubs](https://github.com/Josverl/micropython-stubs) and
[CircuitPython](https://github.com/adafruit/circuitpython) projects.

## Supported boards

TBD.

## What gets analysed

**Your project's `.py` files are read directly.** Your own modules, and any pure-Python files
in the project folder, get full autocomplete and type checking with no stubs needed.

**Stubs cover what isn't a file in your project.** The firmware's built-in modules, like `machine`,
`board`, etc are built-in to the MicroPython or CircuitPython interpreter on the device,
so their types come from the bundled stubs.
Libraries present as compiled `.mpy` bytecode files cannot be read, so they would need stubs to
be provided alongside it to get autocomplete and type checking.

## Licence

MIT, see [LICENSE](LICENSE).
Extension based on Microsoft's LSP web extension sample, MIT.
