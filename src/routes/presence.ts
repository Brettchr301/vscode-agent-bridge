/**
 * Room presence tracking
 *
 * Tracks which person is in which room using:
 *  A) Phone ping detection (IP reachability via ICMP ping / ARP table)
 *  B) Manual check-in/out (called from iOS Shortcuts, Tasker, NFC tags, etc.)
 *  C) AI agent / Slack command  ("I'm in the kitchen" → /presence/checkin)
 *
 * Phone ping flow:
 *  1. Register phones: POST /presence/phones  { person, name, ip, mac? }
 *  2. Run a periodic scan: POST /presence/scan
 *     → pings each registered IP; present = true means person is home
 *  3. Combine with manual room check-ins for per-room resolution
 *
 * Endpoints
 *   GET  /presence/rooms            current occupancy map
 *   GET  /presence/phones           registered tracking devices
 *   POST /presence/phones           register a phone/device  { person, name, ip, mac?, room? }
 *   PUT  /presence/phones           update a phone  { id, ...fields }
 *   DELETE /presence/phones?id=     remove a phone
 *   POST /presence/checkin          { person, room }   — manual rooms check-in
 *   POST /presence/checkout         { person, room? }  — leave room (or all rooms)
 *   POST /presence/scan             ping all registered phones, update home/away status
 *   GET  /presence/who-is-home      list people currently detected at home
 *   GET  /presence/is-room-clear?room=  boolean — true if no one is in the room
 */
import * as http from 'http';
import * as fs   from 'fs';
import * as np   from 'path';
import * as os   from 'os';
import { exec }  from 'child_process';
import { RouteContext, RouteModule } from '../types';
import { send, runShellAndCapture } from '../helpers';

// ─── Persistence ─────────────────────────────────────────────────────────────

const PHONES_PATH   = np.join(os.homedir(), '.agent-bridge', 'presence-phones.json');
const PRESENCE_PATH = np.join(os.homedir(), '.agent-bridge', 'presence-state.json');

interface TrackedPhone {
  id:       string;
  person:   string;   // e.g. "Brett"
  name:     string;   // e.g. "Brett's iPhone"
  ip:       string;   // local IP e.g. 192.168.1.42
  mac?:     string;   // MAC address for ARP lookup
  room?:    string;   // last known room, updated manually or via AP association
  added:    number;
}

interface PersonPresence {
  person:     string;
  rooms:      string[];   // rooms they are currently in (can be multiple, e.g. kitchen, patio)
  home:       boolean;    // reachable via ping
  last_seen:  number;     // Unix ms of last successful ping
  last_scan:  number;     // Unix ms of last scan attempt
  last_checkin: number;   // Unix ms of last manual check-in
}

function loadPhones(): TrackedPhone[] {
  try {
    const raw = fs.readFileSync(PHONES_PATH, 'utf-8');
    return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) as TrackedPhone[];
  } catch { return []; }
}

function savePhones(phones: TrackedPhone[]) {
  const dir = np.dirname(PHONES_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PHONES_PATH, JSON.stringify(phones, null, 2), 'utf-8');
}

function loadState(): Map<string, PersonPresence> {
  try {
    const raw = fs.readFileSync(PRESENCE_PATH, 'utf-8');
    const arr = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) as PersonPresence[];
    return new Map(arr.map(p => [p.person, p]));
  } catch { return new Map(); }
}

function saveState(state: Map<string, PersonPresence>) {
  const dir = np.dirname(PRESENCE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PRESENCE_PATH, JSON.stringify([...state.values()], null, 2), 'utf-8');
}

// In-memory cache (loaded at module init, written through on changes)
let presenceCache: Map<string, PersonPresence> = loadState();

function getOrCreate(person: string): PersonPresence {
  if (!presenceCache.has(person)) {
    presenceCache.set(person, { person, rooms: [], home: false, last_seen: 0, last_scan: 0, last_checkin: 0 });
  }
  return presenceCache.get(person)!;
}

// ─── Exported helper — used by iot.ts for roomba avoid-occupied ──────────────

/** Returns a lowercase list of all rooms that currently have at least one person in them. */
export function getOccupiedRooms(): string[] {
  const rooms = new Set<string>();
  for (const p of presenceCache.values()) {
    if (p.home) {
      for (const r of p.rooms) rooms.add(r.toLowerCase());
    }
  }
  return [...rooms];
}

/** Returns true if anyone is currently home (regardless of room). */
export function isAnyoneHome(): boolean {
  return [...presenceCache.values()].some(p => p.home);
}

// ─── Ping helpers ─────────────────────────────────────────────────────────────

/** Ping an IP once, return true if reachable (Windows & Unix). */
function pingOnce(ip: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise(resolve => {
    const isWin = process.platform === 'win32';
    // Windows: ping -n 1 -w <ms>  | Unix: ping -c 1 -W <secs>
    const cmd = isWin
      ? `ping -n 1 -w ${timeoutMs} ${ip}`
      : `ping -c 1 -W ${Math.ceil(timeoutMs / 1000)} ${ip}`;
    exec(cmd, { timeout: timeoutMs + 1000, windowsHide: true }, (err, stdout) => {
      const output = stdout.toLowerCase();
      const alive = !err && (output.includes('ttl=') || output.includes('bytes from'));
      resolve(alive);
    });
  });
}

/** Check ARP table for a MAC address — more reliable for phones that don't respond to ping. */
async function arpLookup(mac: string): Promise<boolean> {
  if (!mac) return false;
  const normMac = mac.toLowerCase().replace(/[:-]/g, '');
  try {
    const r = await runShellAndCapture('arp -a', process.cwd(), 5000);
    const normalized = r.stdout.toLowerCase().replace(/[:-]/g, '');
    return normalized.includes(normMac);
  } catch { return false; }
}

/** Detect a phone's presence: try ping first, fall back to ARP. */
async function detectPhone(phone: TrackedPhone): Promise<boolean> {
  const alive = await pingOnce(phone.ip, 2000);
  if (alive) return true;
  if (phone.mac) return arpLookup(phone.mac);
  return false;
}

/** Scan all registered phones and update presence state. */
async function scanAll(): Promise<{ person: string; home: boolean; method: string }[]> {
  const phones = loadPhones();
  const now = Date.now();

  const results = await Promise.allSettled(
    phones.map(async phone => {
      const alive = await detectPhone(phone);
      let method = 'ping';
      // If ping failed but MAC provided, ARP already tried inside detectPhone
      if (!alive && phone.mac) method = 'arp';

      const p = getOrCreate(phone.person);
      const wasHome = p.home;
      p.home = alive;
      p.last_scan = now;
      if (alive) { p.last_seen = now; method = 'ping+alive'; }

      // If they just left home, clear all rooms
      if (wasHome && !alive) { p.rooms = []; }

      // If a default room is registered on the phone and they just arrived, auto-checkin
      if (!wasHome && alive && phone.room) {
        if (!p.rooms.includes(phone.room)) p.rooms.push(phone.room);
      }

      presenceCache.set(phone.person, p);
      return { person: phone.person, home: alive, method };
    })
  );

  saveState(presenceCache);

  return results
    .filter(r => r.status === 'fulfilled')
    .map(r => (r as PromiseFulfilledResult<{ person: string; home: boolean; method: string }>).value);
}

// ─── Route handler ────────────────────────────────────────────────────────────

export const presenceRoutes: RouteModule = async (ctx: RouteContext): Promise<boolean> => {
  const { meth, pathStr, qp, b, res } = ctx;

  if (!pathStr.startsWith('/presence')) return false;

  // ── GET /presence/rooms ──────────────────────────────────────────────────
  if (meth === 'GET' && pathStr === '/presence/rooms') {
    const rooms: Record<string, string[]> = {};
    for (const [person, p] of presenceCache.entries()) {
      if (!p.home) continue;
      for (const room of p.rooms) {
        if (!rooms[room]) rooms[room] = [];
        rooms[room].push(person);
      }
    }
    const occupied = getOccupiedRooms();
    send(res, 200, { ok: true, occupied_rooms: occupied, map: rooms, anyone_home: isAnyoneHome() });
    return true;
  }

  // ── GET /presence/who-is-home ────────────────────────────────────────────
  if (meth === 'GET' && pathStr === '/presence/who-is-home') {
    const home = [...presenceCache.values()].filter(p => p.home);
    send(res, 200, {
      ok: true,
      count: home.length,
      people: home.map(p => ({
        person: p.person,
        rooms: p.rooms,
        last_seen: p.last_seen ? new Date(p.last_seen).toISOString() : null,
      })),
    });
    return true;
  }

  // ── GET /presence/is-room-clear ──────────────────────────────────────────
  if (meth === 'GET' && pathStr === '/presence/is-room-clear') {
    const room = String(qp.room ?? '').trim().toLowerCase();
    if (!room) { send(res, 400, { ok: false, error: 'room required' }); return true; }
    const occupied = getOccupiedRooms();
    const clear = !occupied.includes(room);
    const occupants = [...presenceCache.values()]
      .filter(p => p.home && p.rooms.map(r => r.toLowerCase()).includes(room))
      .map(p => p.person);
    send(res, 200, { ok: true, room, clear, occupants });
    return true;
  }

  // ── GET /presence/phones ─────────────────────────────────────────────────
  if (meth === 'GET' && pathStr === '/presence/phones') {
    const phones = loadPhones();
    send(res, 200, { ok: true, count: phones.length, phones });
    return true;
  }

  // ── POST /presence/phones ────────────────────────────────────────────────
  if (meth === 'POST' && pathStr === '/presence/phones') {
    const person = String(b.person ?? '').trim();
    const name   = String(b.name ?? '').trim();
    const ip     = String(b.ip ?? '').trim();
    if (!person || !ip) { send(res, 400, { ok: false, error: 'person and ip are required' }); return true; }

    const phones = loadPhones();
    const id = `${person.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`;
    const phone: TrackedPhone = {
      id, person, name: name || `${person}'s Phone`, ip,
      mac:   b.mac   ? String(b.mac)  : undefined,
      room:  b.room  ? String(b.room) : undefined,
      added: Date.now(),
    };
    phones.push(phone);
    savePhones(phones);
    send(res, 200, { ok: true, phone });
    return true;
  }

  // ── PUT /presence/phones ─────────────────────────────────────────────────
  if (meth === 'PUT' && pathStr === '/presence/phones') {
    const id = String(b.id ?? '').trim();
    if (!id) { send(res, 400, { ok: false, error: 'id required' }); return true; }
    const phones = loadPhones();
    const idx = phones.findIndex(p => p.id === id);
    if (idx < 0) { send(res, 404, { ok: false, error: `Phone not found: ${id}` }); return true; }
    phones[idx] = { ...phones[idx], ...b, id } as TrackedPhone;
    savePhones(phones);
    send(res, 200, { ok: true, phone: phones[idx] });
    return true;
  }

  // ── DELETE /presence/phones ──────────────────────────────────────────────
  if (meth === 'DELETE' && pathStr === '/presence/phones') {
    const id = String(qp.id ?? b.id ?? '').trim();
    if (!id) { send(res, 400, { ok: false, error: 'id required' }); return true; }
    let phones = loadPhones();
    const before = phones.length;
    phones = phones.filter(p => p.id !== id);
    if (phones.length === before) { send(res, 404, { ok: false, error: `Phone not found: ${id}` }); return true; }
    savePhones(phones);
    send(res, 200, { ok: true, removed: id });
    return true;
  }

  // ── POST /presence/checkin ───────────────────────────────────────────────
  if (meth === 'POST' && pathStr === '/presence/checkin') {
    const person = String(b.person ?? '').trim();
    const room   = String(b.room ?? '').trim();
    if (!person || !room) { send(res, 400, { ok: false, error: 'person and room are required' }); return true; }

    const p = getOrCreate(person);
    p.home = true;
    p.last_seen = Date.now();
    p.last_checkin = Date.now();
    if (!p.rooms.includes(room)) p.rooms.push(room);
    presenceCache.set(person, p);
    saveState(presenceCache);
    send(res, 200, { ok: true, person, room, current_rooms: p.rooms });
    return true;
  }

  // ── POST /presence/checkout ──────────────────────────────────────────────
  if (meth === 'POST' && pathStr === '/presence/checkout') {
    const person = String(b.person ?? '').trim();
    const room   = b.room ? String(b.room).trim() : null;
    if (!person) { send(res, 400, { ok: false, error: 'person required' }); return true; }

    const p = getOrCreate(person);
    if (room) {
      p.rooms = p.rooms.filter(r => r.toLowerCase() !== room.toLowerCase());
    } else {
      p.rooms = [];
      p.home = false;  // no room specified = person left entirely
    }
    presenceCache.set(person, p);
    saveState(presenceCache);
    send(res, 200, { ok: true, person, cleared: room ?? 'all rooms', current_rooms: p.rooms });
    return true;
  }

  // ── POST /presence/scan ──────────────────────────────────────────────────
  if (meth === 'POST' && pathStr === '/presence/scan') {
    try {
      const results = await scanAll();
      const home = results.filter(r => r.home);
      send(res, 200, {
        ok: true,
        scanned: results.length,
        home_count: home.length,
        results,
        occupied_rooms: getOccupiedRooms(),
      });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // ── POST /presence/set ───────────────────────────────────────────────────
  // Bulk-set a person's full state (useful for Tasker/iOS Shortcuts automation)
  if (meth === 'POST' && pathStr === '/presence/set') {
    const person = String(b.person ?? '').trim();
    if (!person) { send(res, 400, { ok: false, error: 'person required' }); return true; }
    const p = getOrCreate(person);
    if (typeof b.home  === 'boolean') p.home  = b.home;
    if (Array.isArray(b.rooms))       p.rooms = b.rooms as string[];
    if (b.rooms === null)             p.rooms = [];
    p.last_checkin = Date.now();
    presenceCache.set(person, p);
    saveState(presenceCache);
    send(res, 200, { ok: true, person, state: p });
    return true;
  }

  return false;
};
