/**
 * src/services/telemetry.ts
 *
 * In-memory + persisted telemetry store for model performance tracking.
 *
 * Tracks per-model, per-task-type:
 *   • Success / failure counts
 *   • Average latency
 *   • Token usage + estimated cost
 *   • Empirical success rate (rolling 100-call window)
 *
 * This data feeds the orchestrator routing algorithm so the system naturally
 * shifts towards whichever model performs best for each task type at the
 * lowest cost.
 *
 * Routes (all behind bridge auth):
 *   GET  /telemetry/summary               per-model rolled-up stats
 *   GET  /telemetry/records?model=&limit= raw records
 *   POST /telemetry/record                add a record (internal / agent use)
 *   DELETE /telemetry/records             clear history
 */

import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import { randomUUID } from 'crypto';
import { TelemetryRecord, RouteModule } from '../types';
import { send } from '../helpers';

// ─── Persistence ──────────────────────────────────────────────────────────────

const DIR  = path.join(os.homedir(), '.agent-bridge');
const FILE = path.join(DIR, 'telemetry.json');
const MAX  = 2000;  // max records kept on disk

function loadRecords(): TelemetryRecord[] {
  try {
    const raw = fs.readFileSync(FILE, 'utf-8');
    return JSON.parse(raw) as TelemetryRecord[];
  } catch { return []; }
}

function saveRecords(records: TelemetryRecord[]) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(records.slice(-MAX), null, 2), 'utf-8');
}

// ─── In-memory ────────────────────────────────────────────────────────────────

let _records: TelemetryRecord[] = [];
let _seeded = false;

function ensureSeeded() {
  if (_seeded) return;
  _seeded  = true;
  _records = loadRecords();
}

// ─── Model stats aggregator ───────────────────────────────────────────────────

export interface ModelStats {
  model:        string;
  provider:     string;
  calls:        number;
  successes:    number;
  failures:     number;
  successRate:  number;    // 0–1
  avgLatencyMs: number;
  totalTokens:  number;
  totalCostUsd: number;
  byTaskType:   Record<string, { calls: number; successes: number; avgLatencyMs: number }>;
  lastSeen:     number;
}

export function getModelStats(filterModel?: string): ModelStats[] {
  ensureSeeded();
  const map = new Map<string, ModelStats>();

  for (const r of _records) {
    if (filterModel && r.model !== filterModel) continue;
    const key = r.model;
    if (!map.has(key)) {
      map.set(key, {
        model:        r.model,
        provider:     r.provider,
        calls:        0,
        successes:    0,
        failures:     0,
        successRate:  0,
        avgLatencyMs: 0,
        totalTokens:  0,
        totalCostUsd: 0,
        byTaskType:   {},
        lastSeen:     0,
      });
    }
    const s = map.get(key)!;
    s.calls++;
    if (r.success) s.successes++; else s.failures++;
    s.avgLatencyMs = ((s.avgLatencyMs * (s.calls - 1)) + r.latencyMs) / s.calls;
    s.totalTokens  += r.tokens  ?? 0;
    s.totalCostUsd += r.costUsd ?? 0;
    if (r.ts > s.lastSeen) s.lastSeen = r.ts;

    // per task-type
    if (!s.byTaskType[r.taskType]) s.byTaskType[r.taskType] = { calls: 0, successes: 0, avgLatencyMs: 0 };
    const t = s.byTaskType[r.taskType];
    t.calls++;
    if (r.success) t.successes++;
    t.avgLatencyMs = ((t.avgLatencyMs * (t.calls - 1)) + r.latencyMs) / t.calls;
  }

  // compute success rates
  for (const s of map.values()) {
    s.successRate = s.calls > 0 ? s.successes / s.calls : 0;
  }

  return [...map.values()].sort((a, b) => b.calls - a.calls);
}

// ─── Model cost table (USD / 1k tokens) ──────────────────────────────────────

export const MODEL_COST_TABLE: Record<string, number> = {
  // DeepSeek — very cheap
  'deepseek-r1':             0.0014,
  'deepseek-r1-distill-32b': 0.0014,
  'deepseek-chat':           0.0007,
  // OpenAI
  'gpt-4o':                  0.005,
  'gpt-4o-mini':             0.00015,
  'gpt-4-turbo':             0.01,
  'gpt-4':                   0.03,
  // Anthropic
  'claude-3-5-sonnet':       0.003,
  'claude-3-opus':           0.015,     // expensive — use sparingly
  'claude-3-haiku':          0.00025,
  // Copilot (treated as fixed cost through VS Code subscription)
  'copilot':                 0.0,
  'gpt-4o-copilot':          0.0,
};

export function estimateCost(model: string, tokens: number): number {
  const rate = MODEL_COST_TABLE[model] ?? 0.005;
  return (tokens / 1000) * rate;
}

// ─── Public telemetry API ────────────────────────────────────────────────────

export const telemetry = {
  record(r: Omit<TelemetryRecord, 'id' | 'ts'>): void {
    ensureSeeded();
    const rec: TelemetryRecord = {
      ...r,
      id: randomUUID(),
      ts: Date.now(),
      costUsd: r.costUsd ?? estimateCost(r.model, r.tokens ?? 0),
    };
    _records.push(rec);
    // Persist every 20 records
    if (_records.length % 20 === 0) saveRecords(_records);
  },

  getRecords(opts: { model?: string; taskType?: string; limit?: number } = {}): TelemetryRecord[] {
    ensureSeeded();
    let out = _records;
    if (opts.model)    out = out.filter(r => r.model    === opts.model);
    if (opts.taskType) out = out.filter(r => r.taskType === opts.taskType);
    return out.slice(-(opts.limit ?? 100)).reverse();
  },

  getBestModel(taskType: string, candidates: string[]): string {
    ensureSeeded();
    if (candidates.length === 0) return 'deepseek-chat';

    // Score = successRate / (costPer1k + 0.001) — maximize performance per dollar
    const stats = getModelStats();
    const statsMap = new Map(stats.map(s => [s.model, s]));

    let best = candidates[0];
    let bestScore = -1;

    for (const m of candidates) {
      const s = statsMap.get(m);
      const ts      = s?.byTaskType[taskType];
      const rate    = (ts && ts.calls > 2) ? ts.successes / ts.calls : 0.75;
      const cost    = MODEL_COST_TABLE[m] ?? 0.005;
      const score   = rate / (cost + 0.001);
      if (score > bestScore) { bestScore = score; best = m; }
    }

    return best;
  },

  clear(): void {
    _records = [];
    saveRecords([]);
  },

  stats: getModelStats,
};

// ─── HTTP route module ────────────────────────────────────────────────────────

export const telemetryRoutes: RouteModule = async (ctx) => {
  const { meth, pathStr, qp, b, res } = ctx;
  const reply = (code: number, body: unknown) => { send(res, code, body); return true; };

  // GET /telemetry/summary
  if (meth === 'GET' && pathStr === '/telemetry/summary') {
    return reply(200, { ok: true, models: telemetry.stats() });
  }

  // GET /telemetry/records?model=&taskType=&limit=
  if (meth === 'GET' && pathStr === '/telemetry/records') {
    const records = telemetry.getRecords({
      model:    qp.model,
      taskType: qp.taskType,
      limit:    parseInt(qp.limit ?? '100', 10),
    });
    return reply(200, { ok: true, records, count: records.length });
  }

  // POST /telemetry/record  { model, provider, taskType, success, latencyMs, tokens?, costUsd? }
  if (meth === 'POST' && pathStr === '/telemetry/record') {
    const { model, provider, taskType, success, latencyMs, tokens, costUsd, error } = b as Record<string, unknown>;
    if (!model || !taskType) return reply(400, { ok: false, error: 'model and taskType required' });
    telemetry.record({
      model:     model as string,
      provider:  (provider as string) || 'unknown',
      taskType:  taskType as string,
      success:   Boolean(success),
      latencyMs: Number(latencyMs ?? 0),
      tokens:    Number(tokens ?? 0),
      costUsd:   costUsd ? Number(costUsd) : undefined,
      error:     error as string | undefined,
    });
    return reply(200, { ok: true });
  }

  // DELETE /telemetry/records
  if (meth === 'DELETE' && pathStr === '/telemetry/records') {
    telemetry.clear();
    return reply(200, { ok: true, message: 'Telemetry cleared' });
  }

  return false;
};
