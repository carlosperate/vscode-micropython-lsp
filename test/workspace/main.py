"""Manual test bench for the language server.

Opened by `npm run chrome`, which loads this folder as the workspace. Each
numbered block checks one thing, and each fails in its own recognisable way.

Set the target for the session, in Settings. Never pin one in
`.vscode/settings.json`: a workspace value outranks what the integration gate
writes, so it turns every target switch in the gate into a silent no-op.

Nothing here is run. It exists to be hovered, completed and squiggled at.
Several blocks are expected to be red until the matching feature is built; each
says so.
"""

# 1. STDLIB: works today.
#    Hover `sys`, then type `sys.` and expect a completion list. Proves the
#    server booted, the typeshed was seeded and the URI shape resolved.
import sys

print(sys.platform)

# 2. CLOSED MODULE: needs the workspace mirror.
#    helper.py is never opened in an editor, so the server can only know it if
#    the mirror pushed it. Hover `greet` and expect `(name: str) -> str`, not
#    `Unknown`. An empty module means the path was created but not the content.
from helper import Counter, greet

print(greet("micro:bit"))
greet("micro:bit")

counter = Counter(start=10)
counter.increment()  # `.` after `counter` should offer `increment` and `value`

# 3. TYPE ERROR: works today.
#    Expect a squiggle here saying `int` is not `str` (reportArgumentType).
#    A second one about the unused result comes from the engine's default
#    strictness and should disappear once the type checking mode is set.
greet(42)

# 4. DEVICE STUBS: needs the `microbit` target, and is red on every other one.
#    On it, `display.` and `button_a.` complete with docstrings. On a MicroPython
#    or CircuitPython target: "Import could not be resolved", which is correct,
#    since no other board has these modules.
from microbit import button_a, display

display.scroll("hi")
if button_a.is_pressed():
    display.clear()

# 5. THE BYPASS: this one is red on purpose, on every target.
#    `subprocess` is desktop Python and no board has it, so the engine's bundled
#    CPython typeshed being live is exactly the bug the bypass exists to fix. A
#    green line here means the wrong typeshed won and a learner is being offered
#    modules their board does not have.
#
#    Not `asyncio`: MicroPython 1.21+ really does ship it, and the replacement
#    stdlib stubs include it, so it is supposed to resolve. `subprocess` is
#    absent from MicroPython, CircuitPython and micro:bit alike.
import subprocess

# 6. BOARD MODULES: at most one of these three ever resolves at a time.
#    `machine` ships with every MicroPython board and with the micro:bit, while
#    `esp32` and `rp2` each belong to one chip family. Pick an ESP32 target and
#    only `esp32` resolves; pick a Pico and only `rp2` does. On the default
#    target none of them do, which is the point: a user who has not said what
#    they are programming is not offered hardware modules.
import esp32
import machine
import rp2

# 7. THE SHARED BASE: needs a MicroPython target, any of them.
#    MicroPython's standard library keeps its helper types in a package that
#    ships outside the typeshed root, so the build has to move it in. Hover
#    `print_exception` and expect `file: IOBase_mp` in the signature. Left where
#    upstream puts it, `sys` still imports and every type coming through that
#    package is silently `Unknown`, which is what this line is here to catch.
#    (On the micro:bit target the same call resolves to a narrower signature of
#    its own, with no `file` parameter, and that is correct.)
sys.print_exception(ValueError("nothing is wrong"))

# 8. CIRCUITPYTHON: needs a CircuitPython target, and block 6 stays red on one.
#    `board` and `digitalio` are on very nearly every CircuitPython board, so both
#    resolve on any of them and on no MicroPython target. `wifi` is the per-board
#    filter, and the whole point of the flavour: 257 of the 628 boards have a
#    radio, so a Pico W resolves it and a Pico does not, out of the same shared
#    base. `board.` completes with that board's own pin names, which is the one
#    file a board layer carries.
import board
import digitalio
import wifi

pin = board.GP0  # red unless the target is an RP2040 board
