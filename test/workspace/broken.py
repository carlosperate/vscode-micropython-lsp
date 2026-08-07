"""Mirrored, never opened, and deliberately wrong.

Exists to answer one question: does a file the user has not opened produce
Problems entries? The server is pull-model, and VS Code only pulls diagnostics
for documents it knows about, so the answer decides whether whole-workspace
problem reporting is something we can promise at all.

Nothing imports this. Leave the error in place, and don't open it while testing.
"""


def add(a: int, b: int) -> int:
    return a + b


total: str = add(1, 2)
