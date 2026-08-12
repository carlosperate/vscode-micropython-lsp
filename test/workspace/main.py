"""Manual test bench for the language server.

Opened by `npm run chrome`, which loads this folder as the workspace. Each
numbered block checks one thing, and each fails in its own recognisable way.

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

# 4. DEVICE STUBS: expected to FAIL until device stubs are bundled.
#    Until then: "Import could not be resolved". After: `display.` and
#    `button_a.` complete with docstrings.
from microbit import button_a, display

display.scroll("hi")
if button_a.is_pressed():
    display.clear()

# 5. THE BYPASS: this one is backwards on purpose.
#    Right now `subprocess` RESOLVES, and that is the bug: the engine's bundled
#    CPython typeshed is live, so a MicroPython learner can autocomplete modules
#    their board does not have. Once the typeshed is replaced with the board's
#    own, this must fail to resolve. A green line here afterwards means the
#    wrong typeshed won.
#
#    Not `asyncio`: MicroPython 1.21+ really does ship it, and the replacement
#    stdlib stubs include it, so it is supposed to resolve. `subprocess` is
#    absent from MicroPython, CircuitPython and micro:bit alike.
import subprocess
