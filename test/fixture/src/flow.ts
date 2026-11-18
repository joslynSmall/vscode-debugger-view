export interface Reader {
  read(name: string): string;
}

export class FileReader implements Reader {
  read(name: string): string {
    return name;
  }
}

export class MemoryReader implements Reader {
  read(name: string): string {
    return name.toUpperCase();
  }
}

export function pick(reader: Reader): string {
  return reader.read('item');
}

export function leaf(value: string): string {
  return value.trim();
}

export function middle(value: string): string {
  const cleaned = leaf(value);
  return cleaned;
}

export function again(value: string, depth: number): string {
  if (depth <= 0) {
    return leaf(value);
  }
  return again(leaf(value), depth - 1);
}

export function start(value: string, reader: Reader): string {
  const first = middle(value);
  const chosen = pick(reader);
  const nested = again(first, 1);
  return `${first}:${chosen}:${nested}`;
}
