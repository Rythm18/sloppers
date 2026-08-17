import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newCursor, readAppended } from './tailer.js';

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'sloppers-tailer-')), 'log.jsonl');
}

describe('readAppended', () => {
  it('reads complete lines and only new ones on subsequent calls', () => {
    const file = tmpFile();
    writeFileSync(file, 'one\ntwo\n');
    const first = readAppended(file, newCursor());
    expect(first.lines).toEqual(['one', 'two']);

    appendFileSync(file, 'three\n');
    const second = readAppended(file, first.cursor);
    expect(second.lines).toEqual(['three']);

    const third = readAppended(file, second.cursor);
    expect(third.lines).toEqual([]);
  });

  it('holds an incomplete final line until its newline arrives', () => {
    const file = tmpFile();
    writeFileSync(file, 'done\n{"half":');
    const first = readAppended(file, newCursor());
    expect(first.lines).toEqual(['done']);

    appendFileSync(file, '"now whole"}\n');
    const second = readAppended(file, first.cursor);
    expect(second.lines).toEqual(['{"half":"now whole"}']);
  });

  it('does not corrupt multi-byte characters split across reads', () => {
    const file = tmpFile();
    const emoji = Buffer.from('🍜');
    writeFileSync(file, Buffer.concat([Buffer.from('a\nb'), emoji.subarray(0, 2)]));
    const first = readAppended(file, newCursor());
    expect(first.lines).toEqual(['a']);

    appendFileSync(file, Buffer.concat([emoji.subarray(2), Buffer.from('c\n')]));
    const second = readAppended(file, first.cursor);
    expect(second.lines).toEqual(['b🍜c']);
  });

  it('restarts from the top when the file shrinks (rotation)', () => {
    const file = tmpFile();
    writeFileSync(file, 'old-one\nold-two\nold-three\n');
    const first = readAppended(file, newCursor());
    expect(first.lines).toHaveLength(3);

    writeFileSync(file, 'fresh\n');
    const second = readAppended(file, first.cursor);
    expect(second.lines).toEqual(['fresh']);
  });

  it('skips empty lines', () => {
    const file = tmpFile();
    writeFileSync(file, 'a\n\n\nb\n');
    expect(readAppended(file, newCursor()).lines).toEqual(['a', 'b']);
  });
});
