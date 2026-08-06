"""Imported by main.py but never opened in an editor.

That is the whole point: the server has no filesystem, so this module only
resolves if the workspace mirror seeded it. Don't open this file while testing
the mirror. Opening it makes VS Code sync it and hides the failure.
"""

GREETING = "Hello"


def greet(name: str) -> str:
    return f"{GREETING}, {name}!"


class Counter:
    """Something with members, so completion has more than one thing to offer."""

    def __init__(self, start: int = 0) -> None:
        self.value = start

    def increment(self, by: int = 1) -> int:
        self.value += by
        return self.value
