def leaf(value: str) -> str:
    return value.strip()


def middle(value: str) -> str:
    cleaned = leaf(value)
    return cleaned


def start(value: str) -> str:
    first = middle(value)
    return leaf(first)
