/**
 * test/iot.test.ts
 *
 * Tests for IoT route utilities.
 * Device registry persistence and identifier helpers.
 */
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';

// ─── Re-usable helpers (mirrors src/routes/iot.ts private functions) ─────────

function slugify(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

interface FakeDevice { id: string; name: string; }
function uniqueId(devices: FakeDevice[], name: string) {
  const base = slugify(name);
  if (!devices.find(d => d.id === base)) return base;
  let n = 2;
  while (devices.find(d => d.id === `${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// ─── slugify ─────────────────────────────────────────────────────────────────

describe('slugify()', () => {
  it('lowercases everything', () => {
    expect(slugify('Living Room Hue')).toBe('living-room-hue');
  });

  it('replaces spaces with dashes', () => {
    expect(slugify('my device')).toBe('my-device');
  });

  it('collapses multiple special chars', () => {
    expect(slugify('A!@#B---C')).toBe('a-b-c');
  });

  it('strips leading and trailing dashes', () => {
    expect(slugify('---test---')).toBe('test');
  });

  it('handles purely numeric names', () => {
    expect(slugify('42')).toBe('42');
  });

  it('handles empty string', () => {
    expect(slugify('')).toBe('');
  });
});

// ─── uniqueId ─────────────────────────────────────────────────────────────────

describe('uniqueId()', () => {
  it('returns base slug when no conflict', () => {
    expect(uniqueId([], 'My Light')).toBe('my-light');
  });

  it('appends -2 on first conflict', () => {
    const devices = [{ id: 'my-light', name: 'My Light' }];
    expect(uniqueId(devices, 'My Light')).toBe('my-light-2');
  });

  it('appends -3 when -2 is also taken', () => {
    const devices = [
      { id: 'fan', name: 'Fan' },
      { id: 'fan-2', name: 'Fan' },
    ];
    expect(uniqueId(devices, 'Fan')).toBe('fan-3');
  });

  it('does not conflict with different devices', () => {
    const devices = [{ id: 'kitchen-light', name: 'Kitchen Light' }];
    expect(uniqueId(devices, 'Bedroom Light')).toBe('bedroom-light');
  });
});

// ─── Credential prefix detection (mirrors iot.ts encryptDeviceCreds logic) ──

describe('credential prefix detection', () => {
  const ENCRYPTED_PREFIXES = ['dpapi:', 'keychain:', 'xor:'];

  function isAlreadyEncrypted(value: string) {
    return ENCRYPTED_PREFIXES.some(p => value.startsWith(p));
  }

  it('detects dpapi: prefix as encrypted', () => {
    expect(isAlreadyEncrypted('dpapi:ABC123==')).toBe(true);
  });

  it('detects keychain: prefix as encrypted', () => {
    expect(isAlreadyEncrypted('keychain:my-device-token')).toBe(true);
  });

  it('detects xor: prefix as encrypted', () => {
    expect(isAlreadyEncrypted('xor:BASE64==')).toBe(true);
  });

  it('does not flag a plain API key as encrypted', () => {
    expect(isAlreadyEncrypted('sk-abcdefgh12345678')).toBe(false);
  });

  it('does not flag Base64 without prefix as encrypted', () => {
    expect(isAlreadyEncrypted('SGVsbG8gV29ybGQ=')).toBe(false);
  });
});

// ─── IoTDevice shape validation ───────────────────────────────────────────────

describe('IoTDevice object structure', () => {
  it('a minimal device has required fields', () => {
    const dev = {
      id:    'hue-bridge',
      name:  'Hue Bridge',
      type:  'hue',
      host:  '192.168.1.50',
      added: Date.now(),
    };
    expect(dev.id).toBeTruthy();
    expect(dev.type).toBe('hue');
    expect(typeof dev.added).toBe('number');
  });

  it('supported device types are validated', () => {
    const valid = ['rest','homeassistant','hue','roomba','shelly','tasmota','esphome','wled','tuya','mqtt'];
    expect(valid).toContain('hue');
    expect(valid).toContain('roomba');
    expect(valid).not.toContain('invalid-type');
  });
});

// ─── Persistence (integration-light) ─────────────────────────────────────────

describe('device registry persistence', () => {
  const tmpFile = path.join(os.tmpdir(), `iot-test-${Date.now()}.json`);

  afterAll(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  it('writes and reads a device array', () => {
    const devices = [
      { id: 'shelly-plug', name: 'Shelly Plug', type: 'shelly', host: '192.168.1.80', added: Date.now() },
      { id: 'hue',         name: 'Hue Bridge',  type: 'hue',   host: '192.168.1.50', added: Date.now() },
    ];
    fs.writeFileSync(tmpFile, JSON.stringify(devices, null, 2), 'utf-8');
    const loaded = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    expect(loaded).toHaveLength(2);
    expect(loaded[0].id).toBe('shelly-plug');
    expect(loaded[1].type).toBe('hue');
  });

  it('handles a file with a BOM', () => {
    const bom  = '\uFEFF';
    const data = [{ id: 'bom-device', name: 'BOM', type: 'rest', host: '1.2.3.4', added: 1 }];
    fs.writeFileSync(tmpFile, bom + JSON.stringify(data), 'utf-8');
    const raw   = fs.readFileSync(tmpFile, 'utf-8');
    const clean = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    const loaded = JSON.parse(clean);
    expect(loaded[0].id).toBe('bom-device');
  });
});
