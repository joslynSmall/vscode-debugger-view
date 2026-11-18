export function leaf(value) {
  return value.trim();
}

export function middle(value) {
  const cleaned = leaf(value);
  return cleaned;
}

export function start(value) {
  const first = middle(value);
  return leaf(first);
}
