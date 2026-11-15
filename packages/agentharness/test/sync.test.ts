import { describe, expect, it } from 'vitest';
import { diff } from '../src/sync.js';

describe('diff', () => {
  it('uploads new and changed files and removes files deleted locally', () => {
    const local = new Map([
      ['same.md', '"a"'],
      ['changed.md', '"b2"'],
      ['new.md', '"c"'],
    ]);
    const remote = new Map([
      ['same.md', '"a"'],
      ['changed.md', '"b1"'],
      ['deleted.md', '"d"'],
    ]);

    expect(diff(local, remote)).toEqual({
      upload: ['changed.md', 'new.md'],
      remove: ['deleted.md'],
    });
  });

  it('does nothing when the bucket already matches', () => {
    const files = new Map([['office.md', '"a"']]);
    expect(diff(files, files)).toEqual({ upload: [], remove: [] });
  });
});
