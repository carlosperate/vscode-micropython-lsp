# MicroPython & CircuitPython IntelliSense LSP

Add autocomplete, go to definition and inline docs for MicroPython and
CircuitPython projects.

Works on VSCode web, and compatible editors, in the browser.

> **Type checking is not available yet.** The bundled engine does not answer the
> editor's requests for problems, so no errors or warnings are reported and no
> squiggles appear. Everything else, autocomplete, hover and go to definition,
> works. This will be fixed before 1.0.

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

TBD.

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

VS Code runs every Python language server that is installed, and shows all of
their results at once.
So, a general Python server (the Microsoft Python extensions like Pylance,
Pyright) will provide information not applicable to embedded Python projects.

To select this extension as the language server for your project, add this to
the VSCode workspace `.vscode/settings.json` file:

```json
{
  "python.languageServer": "carlosperate.micropython-lsp",
}
```

## Licence

MIT, see [LICENSE](LICENSE).
Extension based on Microsoft's LSP web extension sample, MIT.
