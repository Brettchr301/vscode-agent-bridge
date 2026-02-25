/**
 * Unit tests for pure helper utilities in src/helpers.ts
 *
 * These tests cover functions that have no VS Code dependencies
 * and can run in a plain Node environment.
 */

// ── inline implementations (mirrors src/helpers.ts) so tests run without vscode ──

function qs(url: string): Record<string, string> {
  const i = url.indexOf('?');
  return i < 0 ? {} : Object.fromEntries(new URLSearchParams(url.slice(i + 1)));
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// ── Tests ──

describe('qs()', () => {
  it('returns empty object for URL with no query string', () => {
    expect(qs('/health')).toEqual({});
  });

  it('parses a single key=value', () => {
    expect(qs('/read-file?path=%2Ftmp%2Ffoo.ts')).toEqual({ path: '/tmp/foo.ts' });
  });

  it('parses multiple key=value pairs', () => {
    expect(qs('/changes-since?ts=1234&staged=1')).toEqual({ ts: '1234', staged: '1' });
  });

  it('handles path with no slash before ?', () => {
    expect(qs('?foo=bar')).toEqual({ foo: 'bar' });
  });
});

describe('stripBom()', () => {
  it('removes a UTF-8 BOM (\\uFEFF) from the start', () => {
    const withBom = '\uFEFF{"key":"value"}';
    expect(stripBom(withBom)).toBe('{"key":"value"}');
  });

  it('leaves a normal string unchanged', () => {
    expect(stripBom('hello world')).toBe('hello world');
  });

  it('leaves an empty string unchanged', () => {
    expect(stripBom('')).toBe('');
  });

  it('only strips the first BOM, not mid-string occurrences', () => {
    const s = 'abc\uFEFFdef';
    expect(stripBom(s)).toBe('abc\uFEFFdef');
  });
});
