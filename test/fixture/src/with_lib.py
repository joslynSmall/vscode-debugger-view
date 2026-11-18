from leftpad import pad
from flow import leaf


def use_lib(value: str) -> str:
    padded = pad(value)
    return leaf(padded)
