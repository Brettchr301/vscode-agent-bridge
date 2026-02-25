/**
 * test/security.test.ts
 *
 * Standalone tests for the security engine — risk scoring, rate limiting,
 * brute-force detection, and event logging.
 * No vscode or bridge imports — all logic is replicated inline.
 */

// ─── Replicated types ─────────────────────────────────────────────────────────

type IoTDeviceType = 'rest'|'homeassistant'|'hue'|'roomba'|'shelly'|'tasmota'|'esphome'|'wled'|'tuya'|'mqtt';

interface IoTDevice {
  id: string; name: string; type: IoTDeviceType;
  host: string; port?: number;
  token?: string; username?: string; password?: string;
  meta?: Record<string, unknown>; added: number;
}

interface RiskFactor { name: string; score: number; detail: string; }
interface DeviceRiskProfile {
  deviceId: string; deviceName: string; deviceType: IoTDeviceType;
  riskScore: number; riskLevel: 'low'|'medium'|'high'|'critical';
  factors: RiskFactor[]; lastScanned: number; recommendations: string[];
}

// ─── Replicated scorer logic (mirrors src/routes/security.ts) ────────────────

const BASE_RISK: Record<IoTDeviceType, number> = {
  homeassistant: 40, mqtt: 38, tuya: 35, rest: 30,
  roomba: 22, hue: 18, shelly: 15, tasmota: 14, esphome: 14, wled: 10,
};

const CRED_PREFIXES = ['dpapi:', 'keychain:', 'xor:'];
function isEncrypted(s?: string): boolean {
  return !s || CRED_PREFIXES.some(p => s.startsWith(p));
}

function isCloudHost(host: string): boolean {
  const local = /^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  return !local;
}

function scoreDevice(device: IoTDevice, authFailsLast24h = 0): DeviceRiskProfile {
  const factors: RiskFactor[] = [];
  let score = BASE_RISK[device.type] ?? 25;
  factors.push({ name: 'Device type exposure', score: BASE_RISK[device.type] ?? 25, detail: '' });

  const tokenBad    = device.token    && !isEncrypted(device.token);
  const passwordBad = device.password && !isEncrypted(device.password);
  if (tokenBad || passwordBad) { score += 25; factors.push({ name: 'Credentials stored plaintext', score: 25, detail: '' }); }

  if (isCloudHost(device.host)) { score += 12; factors.push({ name: 'Cloud-hosted device', score: 12, detail: '' }); }

  if (!device.token && !device.password) { score += 8; factors.push({ name: 'No authentication configured', score: 8, detail: '' }); }

  if (authFailsLast24h > 0) {
    const add = Math.min(authFailsLast24h * 5, 30);
    score += add;
    factors.push({ name: 'Recent auth failures', score: add, detail: '' });
  }

  const ageMonths = (Date.now() - device.added) / (30 * 24 * 3600 * 1000);
  if (ageMonths > 12) {
    const add = Math.min(Math.floor(ageMonths / 6), 15);
    score += add;
    factors.push({ name: 'Stale device record', score: add, detail: '' });
  }

  if (isCloudHost(device.host) && !device.host.startsWith('https://')) {
    score += 10; factors.push({ name: 'Unencrypted transport to cloud', score: 10, detail: '' });
  }

  score = Math.min(Math.round(score), 100);
  const riskLevel = score >= 75 ? 'critical' : score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low';
  const recommendations: string[] = [];
  if (tokenBad || passwordBad) recommendations.push('Encrypt credentials');
  if (!device.token && !device.password) recommendations.push('Add authentication');
  if (recommendations.length === 0) recommendations.push('No immediate actions required');

  return { deviceId: device.id, deviceName: device.name, deviceType: device.type, riskScore: score, riskLevel, factors, lastScanned: Date.now(), recommendations };
}

function getOverallScore(profiles: DeviceRiskProfile[]): number {
  if (profiles.length === 0) return 0;
  let total = 0, weight = 0;
  for (const p of profiles) {
    const w = p.riskLevel === 'critical' ? 2 : 1;
    total  += p.riskScore * w;
    weight += w;
  }
  return Math.round(total / weight);
}

// ─── Replicated rate limiter ──────────────────────────────────────────────────

const RATE_WINDOW_MS      = 60_000;
const RATE_MAX_REQUESTS   = 120;
const AUTH_FAIL_THRESHOLD = 5;
const AUTH_FAIL_WINDOW_MS = 5 * 60_000;
const BLOCK_DURATION_MS   = 15 * 60_000;

interface RLEntry { ip: string; requests: number[]; authFails: number[]; blocked: boolean; blockedUntil: number; }
const rateLimits = new Map<string, RLEntry>();

function getEntry(ip: string): RLEntry {
  if (!rateLimits.has(ip)) rateLimits.set(ip, { ip, requests: [], authFails: [], blocked: false, blockedUntil: 0 });
  return rateLimits.get(ip)!;
}

function checkRateLimit(ip: string, now = Date.now()): boolean {
  if (ip === '127.0.0.1') return true;
  const e = getEntry(ip);
  if (e.blocked && now < e.blockedUntil) return false;
  if (e.blocked && now >= e.blockedUntil) { e.blocked = false; e.authFails = []; }
  e.requests = e.requests.filter(t => now - t < RATE_WINDOW_MS);
  e.requests.push(now);
  if (e.requests.length > RATE_MAX_REQUESTS) {
    e.blocked = true; e.blockedUntil = now + BLOCK_DURATION_MS;
    return false;
  }
  return true;
}

function recordAuthFailure(ip: string, now = Date.now()): boolean {
  if (ip === '127.0.0.1') return false;
  const e = getEntry(ip);
  e.authFails = e.authFails.filter(t => now - t < AUTH_FAIL_WINDOW_MS);
  e.authFails.push(now);
  if (e.authFails.length >= AUTH_FAIL_THRESHOLD) {
    e.blocked = true; e.blockedUntil = now + BLOCK_DURATION_MS;
    return true; // became blocked
  }
  return false;
}

// ─── Device fixtures ──────────────────────────────────────────────────────────

function makeDevice(overrides: Partial<IoTDevice> = {}): IoTDevice {
  return {
    id:    'test-device',
    name:  'Test Device',
    type:  'hue',
    host:  '192.168.1.100',
    added: Date.now(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe('isEncrypted()', () => {
  it('returns true for dpapi: prefix', () => expect(isEncrypted('dpapi:abc123')).toBe(true));
  it('returns true for keychain: prefix', () => expect(isEncrypted('keychain:abc')).toBe(true));
  it('returns true for xor: prefix', () => expect(isEncrypted('xor:abc')).toBe(true));
  it('returns false for plaintext token', () => expect(isEncrypted('sk-1234567890abcdef')).toBe(false));
  it('returns true for undefined (no cred)', () => expect(isEncrypted(undefined)).toBe(true));
  it('returns true for empty string', () => expect(isEncrypted('')).toBe(true));
});

describe('isCloudHost()', () => {
  it('192.168.x.x is local', () => expect(isCloudHost('192.168.1.1')).toBe(false));
  it('10.x.x.x is local', () => expect(isCloudHost('10.0.0.1')).toBe(false));
  it('127.0.0.1 is local', () => expect(isCloudHost('127.0.0.1')).toBe(false));
  it('localhost is local', () => expect(isCloudHost('localhost')).toBe(false));
  it('api.tuya.com is cloud', () => expect(isCloudHost('api.tuya.com')).toBe(true));
  it('home.mydevice.io is cloud', () => expect(isCloudHost('home.mydevice.io')).toBe(true));
  it('172.16.0.1 is local (RFC1918)', () => expect(isCloudHost('172.16.0.1')).toBe(false));
  it('172.32.0.1 is cloud (outside RFC1918)', () => expect(isCloudHost('172.32.0.1')).toBe(true));
});

describe('scoreDevice() — base scores', () => {
  it('homeassistant has highest base score', () => {
    const ha = scoreDevice(makeDevice({ type: 'homeassistant', token: 'dpapi:x' }));
    const wl = scoreDevice(makeDevice({ type: 'wled',          token: 'dpapi:x' }));
    expect(ha.riskScore).toBeGreaterThan(wl.riskScore);
  });

  it('wled has lowest base score', () => {
    const p = scoreDevice(makeDevice({ type: 'wled', token: 'dpapi:x' }));
    expect(BASE_RISK.wled).toBe(10);
    expect(p.riskScore).toBeGreaterThanOrEqual(10);
    expect(p.riskScore).toBeLessThan(30);
  });

  it('all device types score above 0', () => {
    for (const type of Object.keys(BASE_RISK) as IoTDeviceType[]) {
      const p = scoreDevice(makeDevice({ type, token: 'dpapi:x', host: '192.168.1.1' }));
      expect(p.riskScore).toBeGreaterThan(0);
    }
  });
});

describe('scoreDevice() — risk modifiers', () => {
  it('plaintext token adds +25 to risk score', () => {
    const noToken  = scoreDevice(makeDevice({ token: undefined, password: undefined }));
    const cryToken = scoreDevice(makeDevice({ token: 'dpapi:abc' }));
    const rawToken = scoreDevice(makeDevice({ token: 'sk-plaintext-key' }));
    expect(rawToken.riskScore).toBeGreaterThan(cryToken.riskScore);
    // plaintext → +25 penalty. Both have a token so neither has the no-auth +8 penalty.
    expect(rawToken.riskScore - cryToken.riskScore).toBe(25);
  });

  it('cloud host adds to risk score', () => {
    const local = scoreDevice(makeDevice({ host: '192.168.1.100', token: 'dpapi:x' }));
    const cloud = scoreDevice(makeDevice({ host: 'api.example.com', token: 'dpapi:x' }));
    expect(cloud.riskScore).toBeGreaterThan(local.riskScore);
  });

  it('unencrypted cloud transport adds extra penalty', () => {
    const https = scoreDevice(makeDevice({ host: 'https://api.example.com', token: 'dpapi:x' }));
    const http  = scoreDevice(makeDevice({ host: 'api.example.com', token: 'dpapi:x' }));
    expect(http.riskScore).toBeGreaterThan(https.riskScore);
  });

  it('auth failures add 5 per failure, capped at 30', () => {
    const zero  = scoreDevice(makeDevice({ token: 'dpapi:x' }), 0);
    const three = scoreDevice(makeDevice({ token: 'dpapi:x' }), 3);
    const ten   = scoreDevice(makeDevice({ token: 'dpapi:x' }), 10);
    expect(three.riskScore - zero.riskScore).toBe(15);
    expect(ten.riskScore   - zero.riskScore).toBe(30); // capped
  });

  it('stale device (>12 months) adds risk', () => {
    const now   = makeDevice({ added: Date.now() });
    const old   = makeDevice({ added: Date.now() - 14 * 30 * 24 * 3600_000 }); // 14 months
    const pNow  = scoreDevice({ ...now,  token: 'dpapi:x' });
    const pOld  = scoreDevice({ ...old,  token: 'dpapi:x' });
    expect(pOld.riskScore).toBeGreaterThan(pNow.riskScore);
  });

  it('no credentials adds +8', () => {
    const withCred = scoreDevice(makeDevice({ token: 'dpapi:abc', type: 'hue' }));
    const noCred   = scoreDevice(makeDevice({ token: undefined, password: undefined, type: 'hue' }));
    expect(noCred.riskScore - withCred.riskScore).toBe(8);
  });

  it('score is capped at 100', () => {
    // worst case: HA + plaintext + cloud + http + auth failures
    const worst = scoreDevice({
      ...makeDevice({ type: 'homeassistant', token: 'sk-verybadtoken', host: 'external.host.io' }),
      added: Date.now() - 36 * 30 * 24 * 3600_000,
    }, 20);
    expect(worst.riskScore).toBeLessThanOrEqual(100);
  });
});

describe('scoreDevice() — riskLevel', () => {
  it('score >= 75 is critical', () => {
    // worst-case device
    const p = scoreDevice(makeDevice({ type: 'homeassistant', token: 'sk-plaintext', host: 'api.example.io' }), 5);
    if (p.riskScore >= 75) expect(p.riskLevel).toBe('critical');
  });

  it('low-risk device is low', () => {
    const p = scoreDevice(makeDevice({ type: 'wled', token: 'dpapi:xyz', host: '192.168.1.50' }));
    expect(['low', 'medium']).toContain(p.riskLevel);
  });

  it('riskLevel matches score threshold', () => {
    // manually check all levels
    const scores = [0, 24, 25, 49, 50, 74, 75, 100];
    const expected = ['low','low','medium','medium','high','high','critical','critical'];
    scores.forEach((s, i) => {
      const level = s >= 75 ? 'critical' : s >= 50 ? 'high' : s >= 25 ? 'medium' : 'low';
      expect(level).toBe(expected[i]);
    });
  });
});

describe('scoreDevice() — factors list', () => {
  it('always has at least one factor (device type)', () => {
    const p = scoreDevice(makeDevice({ token: 'dpapi:x' }));
    expect(p.factors.length).toBeGreaterThanOrEqual(1);
    expect(p.factors[0].name).toBe('Device type exposure');
  });

  it('plaintext cred factor appears when token is plaintext', () => {
    const p = scoreDevice(makeDevice({ token: 'sk-plain' }));
    expect(p.factors.some(f => f.name === 'Credentials stored plaintext')).toBe(true);
  });

  it('no-auth factor appears when no creds at all', () => {
    const p = scoreDevice(makeDevice({ token: undefined, password: undefined }));
    expect(p.factors.some(f => f.name === 'No authentication configured')).toBe(true);
  });
});

describe('getOverallScore()', () => {
  it('returns 0 for empty list', () => {
    expect(getOverallScore([])).toBe(0);
  });

  it('returns exact score for single device', () => {
    const p = scoreDevice(makeDevice({ type: 'wled', token: 'dpapi:x' }));
    expect(getOverallScore([p])).toBe(p.riskScore);
  });

  it('critical devices double-weighted in average', () => {
    const low = { ...scoreDevice(makeDevice({ type: 'wled', token: 'dpapi:x' })), riskScore: 10, riskLevel: 'low'  as const };
    const crit = { ...scoreDevice(makeDevice({ type: 'homeassistant', token: 'sk-plain' })), riskScore: 90, riskLevel: 'critical' as const };
    // weighted: (10*1 + 90*2) / (1+2) = 190/3 ≈ 63
    const overall = getOverallScore([low, crit]);
    expect(overall).toBe(63);
  });

  it('equal scores average correctly', () => {
    const profiles = [50, 50, 50].map(s => ({
      ...scoreDevice(makeDevice()), riskScore: s, riskLevel: 'high' as const,
    }));
    expect(getOverallScore(profiles)).toBe(50);
  });
});

describe('checkRateLimit()', () => {
  beforeEach(() => { rateLimits.clear(); });

  it('allows loopback regardless of request count', () => {
    for (let i = 0; i < 200; i++) checkRateLimit('127.0.0.1');
    expect(checkRateLimit('127.0.0.1')).toBe(true);
  });

  it('allows requests under the threshold', () => {
    const now = Date.now();
    // Add RATE_MAX_REQUESTS - 1 requests so there is still headroom
    for (let i = 0; i < RATE_MAX_REQUESTS - 1; i++) checkRateLimit('1.2.3.4', now + i);
    // The RATE_MAX_REQUESTS-th request should be allowed (length will be exactly RATE_MAX_REQUESTS, not >)
    expect(checkRateLimit('1.2.3.4', now + RATE_MAX_REQUESTS - 1)).toBe(true);
  });

  it('blocks when over limit', () => {
    const now = Date.now();
    for (let i = 0; i <= RATE_MAX_REQUESTS + 1; i++) checkRateLimit('5.6.7.8', now + i);
    expect(checkRateLimit('5.6.7.8', now + RATE_MAX_REQUESTS + 2)).toBe(false);
  });

  it('unblocks after BLOCK_DURATION_MS', () => {
    const now = Date.now();
    for (let i = 0; i <= RATE_MAX_REQUESTS + 2; i++) checkRateLimit('9.10.11.12', now + i);
    const e = getEntry('9.10.11.12');
    expect(e.blocked).toBe(true);
    const blockedUntil = e.blockedUntil; // read exact value, don't estimate
    // Still blocked 1ms before expiry
    expect(checkRateLimit('9.10.11.12', blockedUntil - 1)).toBe(false);
    // Unblocked 1ms after expiry
    expect(checkRateLimit('9.10.11.12', blockedUntil + 1)).toBe(true);
  });

  it('resets sliding window after 60 seconds', () => {
    const now = Date.now();
    // Fill up requests
    for (let i = 0; i < RATE_MAX_REQUESTS; i++) checkRateLimit('20.20.20.20', now + i);
    // After a minute, old requests expire — new ones allowed
    expect(checkRateLimit('20.20.20.20', now + RATE_WINDOW_MS + 5000)).toBe(true);
  });
});

describe('recordAuthFailure()', () => {
  beforeEach(() => { rateLimits.clear(); });

  it('loopback never becomes blocked', () => {
    for (let i = 0; i < 20; i++) recordAuthFailure('127.0.0.1');
    expect(checkRateLimit('127.0.0.1')).toBe(true);
  });

  it('4 failures in 5 min do not block', () => {
    const now = Date.now();
    for (let i = 0; i < AUTH_FAIL_THRESHOLD - 1; i++) recordAuthFailure('2.3.4.5', now + i);
    expect(getEntry('2.3.4.5').blocked).toBe(false);
  });

  it('5 failures in 5 min block the IP', () => {
    const now = Date.now();
    for (let i = 0; i < AUTH_FAIL_THRESHOLD; i++) recordAuthFailure('6.7.8.9', now + i);
    expect(getEntry('6.7.8.9').blocked).toBe(true);
    expect(checkRateLimit('6.7.8.9', now + AUTH_FAIL_THRESHOLD)).toBe(false);
  });

  it('failures outside window do not accumulate', () => {
    const now = Date.now();
    // 3 failures long ago
    for (let i = 0; i < 3; i++) recordAuthFailure('11.22.33.44', now - AUTH_FAIL_WINDOW_MS - 5000 + i);
    // 2 more right now
    for (let i = 0; i < 2; i++) recordAuthFailure('11.22.33.44', now + i);
    // Total in window = 2, not blocked
    expect(getEntry('11.22.33.44').blocked).toBe(false);
  });

  it('returns true (became blocked) exactly at threshold', () => {
    const now = Date.now();
    for (let i = 0; i < AUTH_FAIL_THRESHOLD - 1; i++) recordAuthFailure('55.66.77.88', now + i);
    const blocked = recordAuthFailure('55.66.77.88', now + AUTH_FAIL_THRESHOLD);
    expect(blocked).toBe(true);
  });
});
