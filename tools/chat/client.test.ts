import { describe, expect, it } from 'vitest';
import { lines } from './client.ts';

async function* chunks(...parts: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) {
    await Promise.resolve();
    yield part;
  }
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<string[]> {
  const found: string[] = [];
  for await (const line of lines(source)) found.push(line);
  return found;
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('lines', () => {
  it('joins a line split across chunks and skips blank lines', async () => {
    expect(await collect(chunks(bytes('{"a":'), bytes('1}\n\n{"b"'), bytes(':2}\n')))).toEqual([
      '{"a":1}',
      '{"b":2}',
    ]);
  });

  it('keeps a multi-byte character split between chunks', async () => {
    const fern = bytes('Ferngus 🌿\n');
    expect(await collect(chunks(fern.slice(0, 10), fern.slice(10)))).toEqual(['Ferngus 🌿']);
  });

  it('returns a last line without a newline', async () => {
    expect(await collect(chunks(bytes('one\ntwo')))).toEqual(['one', 'two']);
  });
});
