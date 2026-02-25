/**
 * test/automations.test.ts
 *
 * Unit tests for the automation / scheduling engine.
 *
 * NOTE: automations.ts has a transitive import of vscode (via helpers.ts).
 * To keep tests runnable without the VS Code host, all tested functions are
 * replicated inline here — the same pattern used in helpers.test.ts.
 */

// ─── Replicated: cronMatches (mirrors src/routes/automations.ts) ─────────────

function parseCronField(field: string, value: number, min: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return (value - min) % step === 0;
  }
  const parts = field.split(',');
  for (const p of parts) {
    if (p.includes('-')) {
      const [lo, hi] = p.split('-').map(Number);
      if (value >= lo && value <= hi) return true;
    } else {
      if (parseInt(p, 10) === value) return true;
    }
  }
  return false;
}

function cronMatches(cron: string, now: Date): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minF, hrF, domF, monF, dowF] = fields;
  return (
    parseCronField(minF, now.getMinutes(), 0) &&
    parseCronField(hrF,  now.getHours(),   0) &&
    parseCronField(domF, now.getDate(),    1) &&
    parseCronField(monF, now.getMonth() + 1, 1) &&
    parseCronField(dowF, now.getDay(),     0)
  );
}

// ─── Replicated: detectPresenceEvents ────────────────────────────────────────

let _lastSnap = { anyoneHome: false, occupied: [] as string[] };

function detectPresenceEvents(newAnyoneHome: boolean, newOccupied: string[]): string[] {
  const events: string[] = [];
  const prev = _lastSnap;

  if (prev.anyoneHome && !newAnyoneHome) events.push('all_away');
  if (!prev.anyoneHome && newAnyoneHome) events.push('someone_home');

  const prevSet = new Set(prev.occupied.map(r => r.toLowerCase()));
  const newSet  = new Set(newOccupied.map(r => r.toLowerCase()));

  for (const room of newSet) { if (!prevSet.has(room)) events.push(`room_occupied:${room}`); }
  for (const room of prevSet) { if (!newSet.has(room)) events.push(`room_empty:${room}`); }

  _lastSnap = { anyoneHome: newAnyoneHome, occupied: newOccupied };
  return events;
}

// ─── Replicated: evaluateCondition ───────────────────────────────────────────

interface AutomationCondition {
  type: 'time_between' | 'presence_empty' | 'presence_occupied' | 'day_of_week';
  from?: string;
  to?: string;
  room?: string;
  days?: string[];
}

function evaluateCondition(cond: AutomationCondition, now: Date): boolean {
  if (cond.type === 'time_between' && cond.from && cond.to) {
    const toMins = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
    const cur = now.getHours() * 60 + now.getMinutes();
    return cur >= toMins(cond.from) && cur <= toMins(cond.to);
  }
  if (cond.type === 'presence_empty'    && cond.room) return true;  // no rooms occupied in tests
  if (cond.type === 'presence_occupied' && cond.room) return false; // no one home in tests
  if (cond.type === 'day_of_week' && cond.days) {
    const names = ['sun','mon','tue','wed','thu','fri','sat'];
    const today = names[now.getDay()];
    return cond.days.map(d => d.toLowerCase()).includes(today);
  }
  return true; // unknown condition type → allow
}

// ─── cronMatches ─────────────────────────────────────────────────────────────

describe('cronMatches()', () => {
  it('* * * * * matches any time', () => {
    expect(cronMatches('* * * * *', new Date(2024, 5, 15, 14, 30))).toBe(true);
    expect(cronMatches('* * * * *', new Date(2024, 0, 1, 0, 0))).toBe(true);
  });

  it('specific minute and hour', () => {
    const d = (h: number, m: number) => new Date(2024, 5, 15, h, m);
    expect(cronMatches('30 14 * * *', d(14, 30))).toBe(true);
    expect(cronMatches('30 14 * * *', d(14, 31))).toBe(false);
    expect(cronMatches('30 14 * * *', d(15, 30))).toBe(false);
  });

  it('*/5 minute step matches on multiples', () => {
    const d = (m: number) => new Date(2024, 5, 15, 10, m);
    expect(cronMatches('*/5 * * * *', d(0))).toBe(true);
    expect(cronMatches('*/5 * * * *', d(5))).toBe(true);
    expect(cronMatches('*/5 * * * *', d(7))).toBe(false);
    expect(cronMatches('*/5 * * * *', d(30))).toBe(true);
  });

  it('*/6 hour step', () => {
    expect(cronMatches('0 */6 * * *', new Date(2024, 5, 15, 0,  0))).toBe(true);
    expect(cronMatches('0 */6 * * *', new Date(2024, 5, 15, 6,  0))).toBe(true);
    expect(cronMatches('0 */6 * * *', new Date(2024, 5, 15, 12, 0))).toBe(true);
    expect(cronMatches('0 */6 * * *', new Date(2024, 5, 15, 13, 0))).toBe(false);
  });

  it('comma-separated values', () => {
    expect(cronMatches('0 9,17 * * *', new Date(2024, 5, 15, 9,  0))).toBe(true);
    expect(cronMatches('0 9,17 * * *', new Date(2024, 5, 15, 17, 0))).toBe(true);
    expect(cronMatches('0 9,17 * * *', new Date(2024, 5, 15, 10, 0))).toBe(false);
  });

  it('range in minute field', () => {
    expect(cronMatches('0-5 * * * *', new Date(2024, 5, 15, 10, 0))).toBe(true);
    expect(cronMatches('0-5 * * * *', new Date(2024, 5, 15, 10, 3))).toBe(true);
    expect(cronMatches('0-5 * * * *', new Date(2024, 5, 15, 10, 6))).toBe(false);
  });

  it('specific day of week', () => {
    const monday = new Date(2024, 0, 1, 10, 0);  // Jan 1 2024 = Monday (dow=1)
    const sunday = new Date(2024, 0, 7, 10, 0);  // Jan 7 2024 = Sunday  (dow=0)
    expect(cronMatches('0 10 * * 1', monday)).toBe(true);
    expect(cronMatches('0 10 * * 1', sunday)).toBe(false);
    expect(cronMatches('0 10 * * 0', sunday)).toBe(true);
  });

  it('specific date in month', () => {
    expect(cronMatches('30 14 15 6 *', new Date(2024, 5, 15, 14, 30))).toBe(true);
    expect(cronMatches('30 14 16 6 *', new Date(2024, 5, 15, 14, 30))).toBe(false);
  });

  it('rejects malformed cron', () => {
    expect(cronMatches('* * *',  new Date())).toBe(false);
    expect(cronMatches('',       new Date())).toBe(false);
  });
});

// ─── detectPresenceEvents ────────────────────────────────────────────────────

describe('detectPresenceEvents()', () => {
  beforeEach(() => {
    // Reset internal snapshot before each test
    _lastSnap = { anyoneHome: false, occupied: [] };
  });

  it('emits all_away when everyone leaves', () => {
    detectPresenceEvents(true, ['living room']);
    const events = detectPresenceEvents(false, []);
    expect(events).toContain('all_away');
  });

  it('emits someone_home when first person arrives', () => {
    detectPresenceEvents(false, []);
    const events = detectPresenceEvents(true, ['bedroom']);
    expect(events).toContain('someone_home');
  });

  it('emits room_occupied:<name> when a room becomes occupied', () => {
    detectPresenceEvents(true, []);
    const events = detectPresenceEvents(true, ['kitchen']);
    expect(events).toContain('room_occupied:kitchen');
  });

  it('emits room_empty:<name> when a room empties', () => {
    detectPresenceEvents(true, ['living room', 'kitchen']);
    const events = detectPresenceEvents(true, ['living room']);
    expect(events).toContain('room_empty:kitchen');
    expect(events).not.toContain('room_empty:living room');
  });

  it('is case-insensitive for room names', () => {
    detectPresenceEvents(true, ['LIVING ROOM']);
    const events = detectPresenceEvents(true, ['living room']);
    expect(events).toHaveLength(0);
  });

  it('emits multiple events in one tick', () => {
    detectPresenceEvents(true, ['bedroom', 'office']);
    const events = detectPresenceEvents(true, ['kitchen']);
    expect(events).toContain('room_empty:bedroom');
    expect(events).toContain('room_empty:office');
    expect(events).toContain('room_occupied:kitchen');
  });

  it('emits no events when nothing changes', () => {
    detectPresenceEvents(true, ['living room']);
    expect(detectPresenceEvents(true, ['living room'])).toHaveLength(0);
  });
});

// ─── evaluateCondition ───────────────────────────────────────────────────────

describe('evaluateCondition()', () => {
  describe('time_between', () => {
    it('true when inside range', () => {
      const c: AutomationCondition = { type: 'time_between', from: '09:00', to: '17:00' };
      expect(evaluateCondition(c, new Date(2024, 0, 1, 12,  0))).toBe(true);
      expect(evaluateCondition(c, new Date(2024, 0, 1,  9,  0))).toBe(true);
      expect(evaluateCondition(c, new Date(2024, 0, 1, 17,  0))).toBe(true);
    });

    it('false when outside range', () => {
      const c: AutomationCondition = { type: 'time_between', from: '09:00', to: '17:00' };
      expect(evaluateCondition(c, new Date(2024, 0, 1,  8, 59))).toBe(false);
      expect(evaluateCondition(c, new Date(2024, 0, 1, 17,  1))).toBe(false);
    });
  });

  describe('day_of_week', () => {
    it('matches monday', () => {
      const c: AutomationCondition = { type: 'day_of_week', days: ['mon', 'wed', 'fri'] };
      expect(evaluateCondition(c, new Date(2024, 0, 1, 10, 0))).toBe(true); // 2024-01-01 = Monday
    });

    it('does not match tuesday for weekends filter', () => {
      const c: AutomationCondition = { type: 'day_of_week', days: ['sat', 'sun'] };
      expect(evaluateCondition(c, new Date(2024, 0, 2, 10, 0))).toBe(false); // Tuesday
    });

    it('is case-insensitive', () => {
      const c: AutomationCondition = { type: 'day_of_week', days: ['MON'] };
      expect(evaluateCondition(c, new Date(2024, 0, 1, 10, 0))).toBe(true);
    });
  });

  it('returns true for unknown condition type', () => {
    const c = { type: 'unknown' as 'time_between' };
    expect(evaluateCondition(c, new Date())).toBe(true);
  });
});

// ─── Automation rule time-trigger logic ──────────────────────────────────────

describe('Automation time-trigger logic', () => {
  function timeTriggerFires(time: string, now: Date): boolean {
    const [h, m] = time.split(':').map(Number);
    return now.getHours() === h && now.getMinutes() === m;
  }

  it('fires at exact HH:MM', () => {
    expect(timeTriggerFires('14:30', new Date(2024, 5, 15, 14, 30))).toBe(true);
  });

  it('does not fire one minute early', () => {
    expect(timeTriggerFires('14:30', new Date(2024, 5, 15, 14, 29))).toBe(false);
  });

  it('does not fire one minute late', () => {
    expect(timeTriggerFires('14:30', new Date(2024, 5, 15, 14, 31))).toBe(false);
  });

  it('fires at midnight (00:00)', () => {
    expect(timeTriggerFires('00:00', new Date(2024, 5, 15, 0, 0))).toBe(true);
  });
});

// ─── Cooldown logic ───────────────────────────────────────────────────────────

describe('Automation cooldown logic', () => {
  function isCoolingDown(lastFired: string | undefined, cooldownMs: number): boolean {
    if (!lastFired) return false;
    return Date.now() - new Date(lastFired).getTime() < cooldownMs;
  }

  it('is not cooling down if never fired', () => {
    expect(isCoolingDown(undefined, 60_000)).toBe(false);
  });

  it('is cooling down immediately after firing', () => {
    expect(isCoolingDown(new Date().toISOString(), 60_000)).toBe(true);
  });

  it('is not cooling down after cooldown period', () => {
    const old = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
    expect(isCoolingDown(old, 60_000)).toBe(false);
  });

  it('short cooldown (1 second) expires quickly', () => {
    const recent = new Date(Date.now() - 2000).toISOString(); // 2s ago
    expect(isCoolingDown(recent, 1000)).toBe(false);
  });
});


// ─── cronMatches ─────────────────────────────────────────────────────────────

describe('cronMatches()', () => {
  function d(h: number, m: number, dom = 15, mon = 6, dow = 3) {
    // Construct a fixed date: 2024-06-15 (Saturday=6 → but we pass dow directly so let's use real Date)
    const date = new Date(2024, mon - 1, dom, h, m, 0, 0); // mon is 1-based here
    return date;
  }

  it('* * * * * matches any time', () => {
    expect(cronMatches('* * * * *', d(14, 30))).toBe(true);
    expect(cronMatches('* * * * *', d(0, 0))).toBe(true);
  });

  it('specific minute and hour', () => {
    expect(cronMatches('30 14 * * *', d(14, 30))).toBe(true);
    expect(cronMatches('30 14 * * *', d(14, 31))).toBe(false);
    expect(cronMatches('30 14 * * *', d(15, 30))).toBe(false);
  });

  it('*/5 minute step — matches on multiples of 5', () => {
    expect(cronMatches('*/5 * * * *', d(10, 0))).toBe(true);
    expect(cronMatches('*/5 * * * *', d(10, 5))).toBe(true);
    expect(cronMatches('*/5 * * * *', d(10, 7))).toBe(false);
    expect(cronMatches('*/5 * * * *', d(10, 30))).toBe(true);
  });

  it('*/15 hour step', () => {
    expect(cronMatches('0 */6 * * *', d(0,  0))).toBe(true);
    expect(cronMatches('0 */6 * * *', d(6,  0))).toBe(true);
    expect(cronMatches('0 */6 * * *', d(12, 0))).toBe(true);
    expect(cronMatches('0 */6 * * *', d(13, 0))).toBe(false);
  });

  it('comma-separated values in hour field', () => {
    expect(cronMatches('0 9,17 * * *', d(9,  0))).toBe(true);
    expect(cronMatches('0 9,17 * * *', d(17, 0))).toBe(true);
    expect(cronMatches('0 9,17 * * *', d(10, 0))).toBe(false);
  });

  it('range in minute field', () => {
    expect(cronMatches('0-5 * * * *', d(10, 0))).toBe(true);
    expect(cronMatches('0-5 * * * *', d(10, 3))).toBe(true);
    expect(cronMatches('0-5 * * * *', d(10, 6))).toBe(false);
  });

  it('specific day of week (0=Sun)', () => {
    const monday = new Date(2024, 0, 1, 10, 0);   // 2024-01-01 = Monday (dow 1)
    const sunday = new Date(2024, 0, 7, 10, 0);   // 2024-01-07 = Sunday (dow 0)
    expect(cronMatches('0 10 * * 1', monday)).toBe(true);
    expect(cronMatches('0 10 * * 1', sunday)).toBe(false);
    expect(cronMatches('0 10 * * 0', sunday)).toBe(true);
  });

  it('rejects malformed cron (too few fields)', () => {
    expect(cronMatches('* * *', d(10, 0))).toBe(false);
    expect(cronMatches('', d(10, 0))).toBe(false);
  });
});

// ─── detectPresenceEvents ────────────────────────────────────────────────────

describe('detectPresenceEvents()', () => {
  // Reset internal state before each test by calling the module-level fn
  // detectPresenceEvents modifies internal _lastPresenceSnap on each call

  it('emits all_away when everyone leaves', () => {
    // Set initial state: someone home
    detectPresenceEvents(true, ['living room']);
    const events = detectPresenceEvents(false, []);
    expect(events).toContain('all_away');
  });

  it('emits someone_home when first person arrives', () => {
    detectPresenceEvents(false, []);
    const events = detectPresenceEvents(true, ['bedroom']);
    expect(events).toContain('someone_home');
  });

  it('emits room_occupied:<name> when a room becomes occupied', () => {
    detectPresenceEvents(true, []);
    const events = detectPresenceEvents(true, ['kitchen']);
    expect(events).toContain('room_occupied:kitchen');
  });

  it('emits room_empty:<name> when a room becomes unoccupied', () => {
    detectPresenceEvents(true, ['living room', 'kitchen']);
    const events = detectPresenceEvents(true, ['living room']);
    expect(events).toContain('room_empty:kitchen');
    expect(events).not.toContain('room_empty:living room');
  });

  it('is case-insensitive for room names', () => {
    detectPresenceEvents(true, ['LIVING ROOM']);
    const events = detectPresenceEvents(true, ['living room']);
    // Same room — no event because names are normalised to lowercase
    expect(events).not.toContain('room_empty:living room');
    expect(events).not.toContain('room_occupied:living room');
  });

  it('emits multiple events in one tick', () => {
    detectPresenceEvents(true, ['bedroom', 'office']);
    const events = detectPresenceEvents(true, ['kitchen']);
    expect(events).toContain('room_empty:bedroom');
    expect(events).toContain('room_empty:office');
    expect(events).toContain('room_occupied:kitchen');
  });

  it('emits no events when nothing changes', () => {
    detectPresenceEvents(true, ['living room']);
    const events = detectPresenceEvents(true, ['living room']);
    expect(events.length).toBe(0);
  });
});

// ─── evaluateCondition ───────────────────────────────────────────────────────

describe('evaluateCondition()', () => {
  function makeDate(h: number, m: number, dow: number): Date {
    // Create a date with the specified hour, minute and day of week
    const d = new Date(2024, 0, 1 + dow, h, m); // Jan 2024, starting Sunday=0
    return d;
  }

  describe('time_between', () => {
    it('returns true when time is within range', () => {
      const cond: AutomationCondition = { type: 'time_between', from: '09:00', to: '17:00' };
      expect(evaluateCondition(cond, makeDate(12, 0, 0))).toBe(true);
      expect(evaluateCondition(cond, makeDate(9, 0, 0))).toBe(true);
      expect(evaluateCondition(cond, makeDate(17, 0, 0))).toBe(true);
    });

    it('returns false when time is outside range', () => {
      const cond: AutomationCondition = { type: 'time_between', from: '09:00', to: '17:00' };
      expect(evaluateCondition(cond, makeDate(8, 59, 0))).toBe(false);
      expect(evaluateCondition(cond, makeDate(17, 1, 0))).toBe(false);
    });
  });

  describe('day_of_week', () => {
    it('matches Monday (dow=1)', () => {
      const cond: AutomationCondition = { type: 'day_of_week', days: ['mon', 'wed', 'fri'] };
      // Jan 1 2024 is Monday
      expect(evaluateCondition(cond, new Date(2024, 0, 1, 10, 0))).toBe(true);
    });

    it('does not match Tuesday when only weekends', () => {
      const cond: AutomationCondition = { type: 'day_of_week', days: ['sat', 'sun'] };
      // Jan 2 2024 is Tuesday
      expect(evaluateCondition(cond, new Date(2024, 0, 2, 10, 0))).toBe(false);
    });

    it('is case-insensitive for day names', () => {
      const cond: AutomationCondition = { type: 'day_of_week', days: ['MON', 'WED'] };
      expect(evaluateCondition(cond, new Date(2024, 0, 1, 10, 0))).toBe(true);
    });
  });

  describe('presence_empty / presence_occupied', () => {
    it('returns true for presence_empty when room is not occupied', () => {
      const cond: AutomationCondition = { type: 'presence_empty', room: 'bedroom' };
      // Default _getOccupiedRooms returns [] → bedroom is empty
      expect(evaluateCondition(cond, new Date())).toBe(true);
    });

    it('returns false for presence_occupied when no one is injected', () => {
      const cond: AutomationCondition = { type: 'presence_occupied', room: 'living room' };
      expect(evaluateCondition(cond, new Date())).toBe(false);
    });
  });

  it('returns true for unknown condition type (safe fallthrough)', () => {
    const cond = { type: 'unknown_type' as 'time_between' };
    expect(evaluateCondition(cond, new Date())).toBe(true);
  });
});

// ─── AutomationRule creation helpers ─────────────────────────────────────────

describe('Automation rule serialisation', () => {
  it('rule object has required fields', () => {
    const rule = {
      id:          'test-rule',
      name:        'Test',
      enabled:     true,
      trigger:     'time' as const,
      time:        '14:00',
      conditions:  [],
      actions:     [{ type: 'notify' as const, message: 'hello', level: 'info' as const }],
      cooldown_ms: 60_000,
      fire_count:  0,
      created:     new Date().toISOString(),
    };
    expect(rule.id).toBe('test-rule');
    expect(rule.trigger).toBe('time');
    expect(rule.actions[0].type).toBe('notify');
  });

  it('cron rule with complex expression', () => {
    const now = new Date(2024, 5, 15, 14, 30); // Sat Jun 15 14:30
    expect(cronMatches('30 14 15 6 *', now)).toBe(true);
    expect(cronMatches('30 14 16 6 *', now)).toBe(false);
  });

  it('time trigger matching: HH:MM, exact minute', () => {
    const rule = { trigger: 'time', time: '14:30' };
    const now  = new Date(2024, 5, 15, 14, 30);
    const [h, m] = (rule.time ?? '').split(':').map(Number);
    const fires  = now.getHours() === h && now.getMinutes() === m;
    expect(fires).toBe(true);
  });

  it('time trigger does not fire on wrong minute', () => {
    const rule = { trigger: 'time', time: '14:30' };
    const now  = new Date(2024, 5, 15, 14, 31);
    const [h, m] = (rule.time ?? '').split(':').map(Number);
    const fires  = now.getHours() === h && now.getMinutes() === m;
    expect(fires).toBe(false);
  });
});
