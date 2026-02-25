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
  // ── Original ──
  | 'rest'            // generic REST/HTTP device
  | 'homeassistant'   // Home Assistant instance
  | 'hue'             // Philips Hue bridge
  | 'roomba'          // iRobot Roomba via HA or cloud
  | 'shelly'          // Shelly smart plugs/relays (local HTTP)
  | 'tasmota'         // Tasmota firmware (local HTTP)
  | 'esphome'         // ESPHome device (local HTTP REST)
  | 'wled'            // WLED LED controller
  | 'tuya'            // Tuya / Smart Life (cloud API)
  | 'mqtt'            // MQTT broker endpoint
  // ── Zigbee / Z-Wave ──
  | 'zigbee2mqtt'     // Zigbee coordinator via Zigbee2MQTT (MQTT topics)
  | 'zwave'           // Z-Wave JS UI (REST + WebSocket)
  | 'deconz'          // deCONZ / Phoscon Zigbee gateway (REST)
  // ── Industrial / Building ──
  | 'modbus'          // Modbus TCP/RTU sensor or PLC
  | 'bacnet'          // BACnet/IP building automation
  | 'knx'             // KNX bus (via KNX IP interface)
  // ── Cameras / Security ──
  | 'onvif'           // ONVIF-compliant IP camera
  | 'ring'            // Ring doorbell / camera (cloud API)
  // ── Smart Home Brands ──
  | 'kasa'            // TP-Link Kasa smart plugs / bulbs (local UDP + cloud)
  | 'govee'           // Govee lights (cloud API)
  | 'nanoleaf'        // Nanoleaf panels (local REST)
  | 'meross'          // Meross smart plugs (cloud API)
  | 'broadlink'       // Broadlink RM IR blasters
  | 'miio'            // Xiaomi Mi Home (miio protocol)
  // ── Climate ──
  | 'nest'            // Google Nest thermostat (cloud API)
  | 'ecobee'          // Ecobee thermostat (cloud API)
  | 'sensibo'         // Sensibo AC controller (cloud API)
  // ── Locks ──
  | 'august'          // August smart lock (cloud API)
  | 'yale'            // Yale smart lock (API)
  | 'schlage'         // Schlage Encode (API)
  // ── Energy / Solar ──
  | 'solar'           // Generic solar inverter (SMA / Fronius / SolarEdge local REST)
  | 'victron'         // Victron Energy MPPT / inverter (Modbus / MQTT)
  | 'powerwall'       // Tesla Powerwall (local REST)
  | 'enphase'         // Enphase IQ Gateway (local REST)
  // ── Vehicle / OBD ──
  | 'obd2'            // OBD-II dongle (ELM327 via WiFi/BT)
  // ── LPWAN / LoRa ──
  | 'lorawan'         // ChirpStack LoRaWAN server (REST)
  // ── CoAP ──
  | 'coap';           // CoAP device (e.g., LwM2M / constrained sensors)

/** A registered IoT device stored in the device registry. */
export interface IoTDevice {
  id:         string;          // unique slug, auto-generated from name
  name:       string;          // human label, e.g. "Living Room Hue"
  type:       IoTDeviceType;
  host:       string;          // IP, hostname, or base URL
  port?:      number;
  token?:     string;          // Bearer token / API key
  username?:  string;
  password?:  string;
  meta?:      Record<string, unknown>;  // type-specific extras (e.g. HUE username)
  added:      number;          // Unix ms timestamp
  protocol?:  string;          // sub-protocol hint (e.g. 'tcp', 'rtu', 'ws')
  unitId?:    number;          // Modbus unit/slave ID
  topicBase?: string;          // MQTT/Zigbee2MQTT base topic
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/** Model roles inside the orchestrator. */
export type ModelRole = 'planner' | 'executor' | 'verifier' | 'judge';

/** Autonomy level for the orchestrator. */
export type AutonomyLevel = 'supervised' | 'assisted' | 'autonomous';

/** Cost tier for model routing. */
export type CostTier = 'nano' | 'micro' | 'standard' | 'premium';

export interface ModelProfile {
  id:          string;           // e.g. 'deepseek-r1', 'gpt-4o', 'claude-opus'
  provider:    string;           // 'deepseek' | 'openai' | 'anthropic' | 'copilot'
  role:        ModelRole;        // current assigned role
  costTier:    CostTier;         // for routing optimization
  costPer1k:   number;           // USD per 1k tokens (used for routing math)
  successRate: number;           // empirical 0–1, updated from telemetry
  avgLatencyMs:number;
  enabled:     boolean;
  suggestedBy?: string;          // agent id that last suggested a role change
}

export interface OrchestratorTask {
  id:          string;
  type:        string;          // 'code_edit' | 'terminal' | 'git' | 'iot' | ...
  description: string;
  autonomy:    AutonomyLevel;
  status:      'pending' | 'planning' | 'proposed' | 'executing' | 'verifying' | 'done' | 'failed' | 'awaiting_approval';
  planner?:    string;          // model id used for planning
  executor?:   string;          // model id used for execution
  verifier?:   string;          // model id used for verification
  proposal?:   unknown;         // planner output
  proposals?:  { model: string; proposal: unknown; score?: number }[];  // parallel proposals
  result?:     unknown;
  error?:      string;
  created:     number;
  updated:     number;
  approvalId?: string;          // if awaiting human approval
}

// ── Approval ─────────────────────────────────────────────────────────────────

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ApprovalRequest {
  id:          string;
  taskId?:     string;
  action:      string;          // human-readable description of what will happen
  payload:     unknown;         // the actual call payload
  risk:        'low' | 'medium' | 'high' | 'critical';
  requestedBy: string;          // model or service id
  status:      ApprovalStatus;
  created:     number;
  expiresAt:   number;
  decidedAt?:  number;
  decidedBy?:  string;
  reason?:     string;          // human reason for rejection
}

// ── Telemetry ─────────────────────────────────────────────────────────────────

export interface TelemetryRecord {
  id:        string;
  ts:        number;
  model:     string;
  provider:  string;
  taskType:  string;
  success:   boolean;
  latencyMs: number;
  tokens?:   number;
  costUsd?:  number;
  error?:    string;
}
