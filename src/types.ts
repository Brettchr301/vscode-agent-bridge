import * as http from 'http';

export interface ShellResult { stdout: string; stderr: string; code: number; }
export interface ChangeEntry  { path: string; ts: number; }
export interface WatchSession  { startTs: number; label: string; }

/** Every route handler receives this context object. */
export interface RouteContext {
  meth:    string;
  pathStr: string;
  qp:      Record<string, string>;
  b:       Record<string, unknown>;
  req:     http.IncomingMessage;
  res:     http.ServerResponse;
}

/** A route module returns true if it handled the request, false to pass through. */
export type RouteModule = (ctx: RouteContext) => Promise<boolean>;

// ── IoT ─────────────────────────────────────────────────────────────────────

/** Supported device types for the IoT registry. */
export type IoTDeviceType =
  | 'rest'           // generic REST/HTTP device
  | 'homeassistant'  // Home Assistant instance
  | 'hue'            // Philips Hue bridge
  | 'roomba'         // iRobot Roomba via Home Assistant or local cloud API
  | 'shelly'         // Shelly smart plugs/relays (local HTTP)
  | 'tasmota'        // Tasmota firmware (local HTTP)
  | 'esphome'        // ESPHome device (local HTTP REST API)
  | 'wled'           // WLED LED controller
  | 'tuya'           // Tuya / Smart Life (cloud API)
  | 'mqtt';          // MQTT broker endpoint

/** A registered IoT device stored in the device registry. */
export interface IoTDevice {
  id:        string;          // unique slug, auto-generated from name
  name:      string;          // human label, e.g. "Living Room Hue"
  type:      IoTDeviceType;
  host:      string;          // IP, hostname, or base URL
  port?:     number;
  token?:    string;          // Bearer token / API key
  username?: string;
  password?: string;
  meta?:     Record<string, unknown>;  // type-specific extras (e.g. HUE username)
  added:     number;          // Unix ms timestamp
}
