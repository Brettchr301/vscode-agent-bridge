/**
 * src/services/approval.ts
 *
 * Optional human-approval gate for destructive or high-risk actions.
 *
 * DISABLED BY DEFAULT.  To enable:
 *   VS Code → Settings → agentBridge.approvalGate.enabled = true
 *   Or: POST /approval/config  { "enabled": true }
 *
 * Flow:
 *   1. Any route that wraps a destructive action calls:
 *        await approvalGate.request({ action, payload, risk, requestedBy })
 *   2. If gate is DISABLED → returns { ok: true } immediately (no-op).
 *   3. If gate is ENABLED:
 *        a. Creates an ApprovalRequest and stores it.
 *        b. Shows a VS Code information message with Approve / Reject buttons.
 *        c. Returns { ok: false, approvalId } so the caller can poll.
 *   4. Caller polls GET /approval/status?id=  or listens for resolution.
 *   5. Human clicks Approve → gate resolves → caller retries.
 *
 * Routes (all behind bridge auth):
 *   GET  /approval/config                    get current gate config
 *   POST /approval/config                    update gate config
 *   GET  /approval/pending                   list all pending requests
 *   GET  /approval/status?id=                get one request
 *   POST /approval/decide  { id, decision, reason? }  human decision
 *
 * Risk classification (auto-detected, can be overridden):
 *   critical  — rm -rf, format, wipe, DROP DATABASE, force-push protected branch
 *   high      — sudo, chmod 777, git push --force, deploy to prod, DELETE endpoint
 *   medium    — write/delete files, git commit, POST/PUT to IoT devices
 *   low       — read-only, status, list
 */

import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import { randomUUID } from 'crypto';
import { ApprovalRequest, ApprovalStatus, RouteContext, RouteModule } from '../types';
import { send } from '../helpers';

// ─── Persistence ──────────────────────────────────────────────────────────────

const DIR   = path.join(os.homedir(), '.agent-bridge');
const FILE  = path.join(DIR, 'approval-log.json');
const TTL   = 10 * 60 * 1000;   // 10-minute window for human response

function loadLog(): ApprovalRequest[] {
  try {
    const raw = fs.readFileSync(FILE, 'utf-8');
    return JSON.parse(raw) as ApprovalRequest[];
  } catch { return []; }
}

function saveLog(log: ApprovalRequest[]) {
  fs.mkdirSync(DIR, { recursive: true });
  // Keep last 500 records
  const trimmed = log.slice(-500);
  fs.writeFileSync(FILE, JSON.stringify(trimmed, null, 2), 'utf-8');
}

// ─── In-memory state ──────────────────────────────────────────────────────────

const _requests = new Map<string, ApprovalRequest>();

// Seed from disk on first demand (lazy)
let _seeded = false;
function ensureSeeded() {
  if (_seeded) return;
  _seeded = true;
  for (const r of loadLog()) _requests.set(r.id, r);
}

// ─── Risk auto-detection keywords ────────────────────────────────────────────

const CRITICAL_PATTERNS = [
  /rm\s+-rf/i, /format\s+[a-z]:/i, /drop\s+database/i, /--force\s+--push/i,
  /wipefs/i, /dd\s+if=/i, /mkfs/i, /shred/i,
];
const HIGH_PATTERNS = [
  /sudo\s+/i, /chmod\s+777/i, /git push.*--force/i, /deploy.*prod/i,
  /DELETE\s+\//, /kubectl\s+delete/i, /terraform\s+destroy/i,
];
const MEDIUM_PATTERNS = [
  /git\s+commit/i, /git\s+push/i, /write.*file/i, /delete.*file/i,
  /POST\s+\/iot/i, /PUT\s+\/iot/i,
];

export function detectRisk(action: string): ApprovalRequest['risk'] {
  if (CRITICAL_PATTERNS.some(p => p.test(action))) return 'critical';
  if (HIGH_PATTERNS.some(p => p.test(action)))     return 'high';
  if (MEDIUM_PATTERNS.some(p => p.test(action)))    return 'medium';
  return 'low';
}

// ─── Gate config ──────────────────────────────────────────────────────────────

interface GateConfig {
  enabled:       boolean;
  minRisk:       ApprovalRequest['risk'];  // only gate actions at/above this risk
  autoApprove:   boolean;     // for testing: auto-approve all
  timeoutMs:     number;
  notifyVSCode:  boolean;
}

const _cfg: GateConfig = {
  enabled:      false,           // OFF by default
  minRisk:      'high',          // only gate high/critical by default when enabled
  autoApprove:  false,
  timeoutMs:    TTL,
  notifyVSCode: true,
};

const RISK_ORDER: Record<ApprovalRequest['risk'], number> = {
  low: 0, medium: 1, high: 2, critical: 3,
};

function meetsThreshold(risk: ApprovalRequest['risk']): boolean {
  return RISK_ORDER[risk] >= RISK_ORDER[_cfg.minRisk];
}

// ─── VS Code notification helper (separate import to avoid circular) ──────────

type NotifyFn = (msg: string, ...items: string[]) => Promise<string | undefined>;
let _notify: NotifyFn | null = null;

export function setNotifyFn(fn: NotifyFn) { _notify = fn; }

// ─── Core service ─────────────────────────────────────────────────────────────

export interface ApprovalGateResult {
  ok:          boolean;
  approvalId?: string;
  status?:     ApprovalStatus;
}

class ApprovalGateService {
  getConfig(): GateConfig { return { ..._cfg }; }
  setConfig(patch: Partial<GateConfig>) { Object.assign(_cfg, patch); }

  /**
   * Check if `action` needs human approval.
   * Returns { ok: true } if gate is off or risk is below threshold.
   * Returns { ok: false, approvalId } if human must decide.
   */
  async request(opts: {
    action:      string;
    payload:     unknown;
    risk?:       ApprovalRequest['risk'];
    requestedBy: string;
    taskId?:     string;
  }): Promise<ApprovalGateResult> {
    const risk = opts.risk ?? detectRisk(opts.action);

    // Gate off → pass through
    if (!_cfg.enabled || !meetsThreshold(risk)) return { ok: true };

    // Auto-approve mode (useful for testing)
    if (_cfg.autoApprove) return { ok: true };

    ensureSeeded();

    const req: ApprovalRequest = {
      id:          randomUUID(),
      taskId:      opts.taskId,
      action:      opts.action,
      payload:     opts.payload,
      risk,
      requestedBy: opts.requestedBy,
      status:      'pending',
      created:     Date.now(),
      expiresAt:   Date.now() + _cfg.timeoutMs,
    };

    _requests.set(req.id, req);
    this._persist();

    // VS Code notification
    if (_cfg.notifyVSCode && _notify) {
      const emoji = risk === 'critical' ? '🔴' : risk === 'high' ? '🟠' : '🟡';
      const choice = await _notify(
        `${emoji} Agent Bridge — Approval Required [${risk.toUpperCase()}]\n${opts.action}`,
        'Approve',
        'Reject',
      );
      if (choice === 'Approve') {
        return this.decide(req.id, 'approved', 'VS Code quick-approve');
      } else if (choice === 'Reject') {
        this.decide(req.id, 'rejected', 'VS Code quick-reject');
      }
    }

    return { ok: false, approvalId: req.id, status: 'pending' };
  }

  /** Human (or agent) records a decision. */
  decide(id: string, decision: 'approved' | 'rejected', reason?: string, decidedBy = 'human'): ApprovalGateResult {
    ensureSeeded();
    const req = _requests.get(id);
    if (!req) return { ok: false, status: 'expired' };

    if (req.status !== 'pending') return { ok: req.status === 'approved', status: req.status };

    req.status    = decision;
    req.decidedAt = Date.now();
    req.decidedBy = decidedBy;
    req.reason    = reason;
    _requests.set(id, req);
    this._persist();

    return { ok: decision === 'approved', approvalId: id, status: req.status };
  }

  get(id: string): ApprovalRequest | undefined {
    ensureSeeded();
    const req = _requests.get(id);
    if (!req) return undefined;
    // Auto-expire
    if (req.status === 'pending' && Date.now() > req.expiresAt) {
      req.status = 'expired';
      _requests.set(id, req);
    }
    return req;
  }

  pending(): ApprovalRequest[] {
    ensureSeeded();
    const now = Date.now();
    const out: ApprovalRequest[] = [];
    for (const r of _requests.values()) {
      if (r.status === 'pending' && now <= r.expiresAt) out.push(r);
    }
    return out.sort((a, b) => b.created - a.created);
  }

  all(limit = 50): ApprovalRequest[] {
    ensureSeeded();
    return [..._requests.values()]
      .sort((a, b) => b.created - a.created)
      .slice(0, limit);
  }

  private _persist() {
    saveLog([..._requests.values()]);
  }
}

export const approvalGate = new ApprovalGateService();

// ─── Route module ─────────────────────────────────────────────────────────────

export const approvalRoutes: RouteModule = async (ctx) => {
  const { meth, pathStr, qp, b, res } = ctx;
  const reply = (code: number, body: unknown) => { send(res, code, body); return true; };

  // GET /approval/config
  if (meth === 'GET' && pathStr === '/approval/config') {
    return reply(200, { ok: true, config: approvalGate.getConfig() });
  }

  // POST /approval/config  { enabled?, minRisk?, autoApprove?, timeoutMs? }
  if (meth === 'POST' && pathStr === '/approval/config') {
    approvalGate.setConfig(b as Partial<GateConfig>);
    return reply(200, { ok: true, config: approvalGate.getConfig() });
  }

  // GET /approval/pending
  if (meth === 'GET' && pathStr === '/approval/pending') {
    return reply(200, { ok: true, pending: approvalGate.pending() });
  }

  // GET /approval/status?id=
  if (meth === 'GET' && pathStr === '/approval/status') {
    const r = approvalGate.get(qp.id);
    if (!r) return reply(404, { ok: false, error: 'Not found' });
    return reply(200, { ok: true, request: r });
  }

  // GET /approval/all?limit=
  if (meth === 'GET' && pathStr === '/approval/all') {
    const limit = parseInt(qp.limit ?? '50', 10);
    return reply(200, { ok: true, requests: approvalGate.all(limit) });
  }

  // POST /approval/decide  { id, decision: 'approved'|'rejected', reason? }
  if (meth === 'POST' && pathStr === '/approval/decide') {
    const id       = (b.id as string)    ?? '';
    const decision = (b.decision as string) ?? '';
    const reason   = (b.reason as string) ?? '';
    if (!id || !['approved', 'rejected'].includes(decision)) {
      return reply(400, { ok: false, error: 'id and decision (approved|rejected) required' });
    }
    const result = approvalGate.decide(id, decision as 'approved' | 'rejected', reason, 'http-api');
    return reply(200, result);
  }

  return false;
};
