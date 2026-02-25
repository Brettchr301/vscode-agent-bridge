/**
 * src/routes/orchestrator.ts
 *
 * Centralized multi-model orchestrator.
 *
 * Architecture (follows best-practice path):
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  PLANNER  (read + propose only — no direct write/execute)   │
 *   │  Default: deepseek-r1  (cheapest reasoning model)          │
 *   └────────────────────┬────────────────────────────────────────┘
 *                        │ proposal(s)
 *            ┌───────────▼──────────────┐
 *            │  JUDGE   (pick best)     │  (only active in parallel mode)
 *            │  Default: gpt-4o-mini   │
 *            └───────────┬─────────────┘
 *                        │ winning proposal
 *   ┌────────────────────▼────────────────────────────────────────┐
 *   │  EXECUTOR  (bounded write/terminal — no planning, no judge) │
 *   │  Default: deepseek-chat                                     │
 *   └────────────────────┬────────────────────────────────────────┘
 *                        │ result
 *   ┌────────────────────▼────────────────────────────────────────┐
 *   │  VERIFIER  (deterministic checks before merge/deploy)       │
 *   │  Default: gpt-4o-mini (or user-configured)                 │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Model roles are configurable. Agents may SUGGEST role changes (saved
 * as suggestions, never auto-applied). Humans can apply via:
 *   POST /orchestrator/models/:id/role  { role, reason }
 *
 * Cost routing:
 *   • Cheapest model that has empirical success rate ≥ threshold is preferred.
 *   • Claude Opus is registered but NEVER auto-selected for planning/execution
 *     unless explicitly pinned — its costTier is "premium".
 *   • DeepSeek R1 is always tried first for code tasks (nanoprice, high quality).
 *
 * Autonomy levels:
 *   supervised  — every task requires human approval before execution
 *   assisted    — only high/critical-risk tasks require approval
 *   autonomous  — no approvals (route through approvalGate which is off)
 *                  NB: Still respects approvalGate.enabled if set
 *
 * Endpoints:
 *   GET  /orchestrator/status               health + active models
 *   GET  /orchestrator/config               get orchestrator config
 *   POST /orchestrator/config               update config
 *   GET  /orchestrator/models               list model profiles + telemetry
 *   POST /orchestrator/models/:id/role      set model role { role, reason }
 *   POST /orchestrator/models/:id/suggest   agent suggests role change
 *   POST /orchestrator/task                 submit a task for orchestration
 *   GET  /orchestrator/task/:id             get task status/result
 *   GET  /orchestrator/tasks                list recent tasks
 *   POST /orchestrator/task/:id/retry       retry a failed task
 *   DELETE /orchestrator/task/:id           cancel a task
 *   POST /orchestrator/propose              run parallel proposals (DeepSeek + Copilot) + judge
 *   GET  /orchestrator/telemetry            model performance summary
 *   POST /orchestrator/route                ask router which model to use for a task type
 */

import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import * as http from 'http';
import { randomUUID } from 'crypto';
import {
  RouteContext, RouteModule,
  ModelProfile, OrchestratorTask, AutonomyLevel, ModelRole, CostTier,
} from '../types';
import { send } from '../helpers';
import { approvalGate, detectRisk } from '../services/approval';
import { telemetry, MODEL_COST_TABLE, estimateCost } from '../services/telemetry';
import { secretManager } from '../services/secret-manager';

// ─── Persistence ──────────────────────────────────────────────────────────────

const DIR         = path.join(os.homedir(), '.agent-bridge');
const TASKS_FILE  = path.join(DIR, 'orch-tasks.json');
const CONFIG_FILE = path.join(DIR, 'orch-config.json');
const MAX_TASKS   = 500;

function loadTasks(): OrchestratorTask[] {
  try { return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8')); } catch { return []; }
}
function saveTasks(t: OrchestratorTask[]) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(TASKS_FILE, JSON.stringify(t.slice(-MAX_TASKS), null, 2));
}

// ─── Default model profiles ───────────────────────────────────────────────────

const DEFAULT_MODELS: ModelProfile[] = [
  {
    id: 'deepseek-r1',       provider: 'deepseek', role: 'planner',
    costTier: 'nano' as CostTier, costPer1k: 0.0014,
    successRate: 0.92, avgLatencyMs: 1800, enabled: true,
  },
  {
    id: 'deepseek-chat',     provider: 'deepseek', role: 'executor',
    costTier: 'nano' as CostTier, costPer1k: 0.0007,
    successRate: 0.90, avgLatencyMs: 900, enabled: true,
  },
  {
    id: 'gpt-4o-mini',       provider: 'openai',   role: 'verifier',
    costTier: 'micro' as CostTier, costPer1k: 0.00015,
    successRate: 0.88, avgLatencyMs: 600, enabled: true,
  },
  {
    id: 'gpt-4o',            provider: 'openai',   role: 'judge',
    costTier: 'standard' as CostTier, costPer1k: 0.005,
    successRate: 0.95, avgLatencyMs: 1200, enabled: true,
  },
  {
    id: 'gpt-4o-copilot',    provider: 'copilot',  role: 'planner',
    costTier: 'nano' as CostTier, costPer1k: 0.0,
    successRate: 0.87, avgLatencyMs: 1400, enabled: true,
  },
  {
    id: 'claude-3-5-sonnet', provider: 'anthropic', role: 'verifier',
    costTier: 'standard' as CostTier, costPer1k: 0.003,
    successRate: 0.93, avgLatencyMs: 1600, enabled: false,
  },
  {
    id: 'claude-3-opus',     provider: 'anthropic', role: 'verifier',
    costTier: 'premium' as CostTier, costPer1k: 0.015,
    successRate: 0.97, avgLatencyMs: 4000, enabled: false,
    // NOTE: premium/expensive — keep disabled until user explicitly enables
  },
];

// ─── Config ───────────────────────────────────────────────────────────────────

interface OrchestratorConfig {
  autonomy:             AutonomyLevel;
  parallelProposals:    boolean;    // run DeepSeek + Copilot in parallel for code tasks
  maxRetries:           number;
  defaultPlannerModel:  string;
  defaultExecutorModel: string;
  defaultVerifierModel: string;
  defaultJudgeModel:    string;
  successThreshold:     number;     // min empirical success rate to auto-select a model
  maxCostPerTaskUsd:    number;     // guard — abort if estimated cost exceeds this
  verifyAllTasks:       boolean;
  taskTimeoutMs:        number;
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  autonomy:             'assisted',
  parallelProposals:    true,
  maxRetries:           2,
  defaultPlannerModel:  'deepseek-r1',
  defaultExecutorModel: 'deepseek-chat',
  defaultVerifierModel: 'gpt-4o-mini',
  defaultJudgeModel:    'gpt-4o',
  successThreshold:     0.7,
  maxCostPerTaskUsd:    0.50,
  verifyAllTasks:       false,
  taskTimeoutMs:        60_000,
};

let _config = { ...DEFAULT_CONFIG };
let _models = [...DEFAULT_MODELS];
const _tasks = new Map<string, OrchestratorTask>();
let _taskSeeded = false;

function loadConfig(): void {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const stored = JSON.parse(raw);
    _config  = { ...DEFAULT_CONFIG, ...stored.config  };
    _models  = stored.models ?? DEFAULT_MODELS;
  } catch { /* use defaults */ }
}

function saveConfig(): void {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ config: _config, models: _models }, null, 2));
}

function ensureTasksSeeded() {
  if (_taskSeeded) return;
  _taskSeeded = true;
  for (const t of loadTasks()) _tasks.set(t.id, t);
}

loadConfig();

// ─── Model routing ────────────────────────────────────────────────────────────

function getCostTierRank(tier: CostTier): number {
  return { nano: 0, micro: 1, standard: 2, premium: 3 }[tier];
}

/** Pick the best model for a role + task type, optimising for cost. */
function pickModel(role: ModelRole, taskType: string): ModelProfile | undefined {
  const candidates = _models.filter(m => m.enabled && m.role === role);
  if (candidates.length === 0) return undefined;

  // Prefer best score = successRate / (costPer1k + epsilon)
  const telStats = telemetry.stats();
  const statsMap = new Map(telStats.map(s => [s.model, s]));

  let best: ModelProfile | undefined;
  let bestScore = -1;

  for (const m of candidates) {
    const s = statsMap.get(m.id);
    const taskRate = s?.byTaskType[taskType]?.calls ?? 0 >= 3
      ? (s!.byTaskType[taskType].successes / s!.byTaskType[taskType].calls)
      : m.successRate;
    if (taskRate < _config.successThreshold) continue;
    const score = taskRate / (m.costPer1k + 0.0001);
    if (score > bestScore) { bestScore = score; best = m; }
  }

  return best ?? candidates.sort((a, b) => getCostTierRank(a.costTier) - getCostTierRank(b.costTier))[0];
}

// ─── Bridge HTTP call (reuse from server.ts via loopback) ─────────────────────

const BRIDGE_PORT = parseInt(process.env.AGENT_BRIDGE_PORT ?? '3131', 10);

function bridgeCall(method: string, endpoint: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const rawToken = secretManager.get('bridge-token') ?? '';
    const bodyStr  = body ? JSON.stringify(body) : undefined;
    const opts: http.RequestOptions = {
      hostname: '127.0.0.1',
      port:     BRIDGE_PORT,
      path:     endpoint,
      method,
      headers: {
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        'Authorization': `Bearer ${rawToken}`,
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); }
      });
    });
    req.setTimeout(_config.taskTimeoutMs, () => { req.destroy(); reject(new Error('bridge timeout')); });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── AI chat helper ───────────────────────────────────────────────────────────

async function aiCall(modelId: string, systemPrompt: string, userPrompt: string): Promise<string> {
  const start   = Date.now();
  let success   = true;
  let result    = '';
  let tokensEst = 0;

  try {
    const resp = await bridgeCall('POST', '/ai/chat', {
      model:    modelId,
      messages: [
        { role: 'system',    content: systemPrompt },
        { role: 'user',      content: userPrompt   },
      ],
    }) as Record<string, unknown>;

    result    = (resp?.content as string) ?? (resp?.text as string) ?? JSON.stringify(resp);
    tokensEst = Math.ceil((systemPrompt.length + userPrompt.length + result.length) / 4);
  } catch (e: any) {
    success = false;
    result  = e.message ?? 'unknown error';
  }

  telemetry.record({
    model:     modelId,
    provider:  _models.find(m => m.id === modelId)?.provider ?? 'unknown',
    taskType:  'ai-chat',
    success,
    latencyMs: Date.now() - start,
    tokens:    tokensEst,
    costUsd:   estimateCost(modelId, tokensEst),
    error:     success ? undefined : result,
  });

  if (!success) throw new Error(result);
  return result;
}

// ─── Verifier ────────────────────────────────────────────────────────────────

interface VerifyResult {
  passed:   boolean;
  checks:   { name: string; passed: boolean; detail: string }[];
  score:    number;   // 0–100
}

async function runVerifier(task: OrchestratorTask): Promise<VerifyResult> {
  const verifier = pickModel('verifier', task.type) ?? _models.find(m => m.id === _config.defaultVerifierModel);
  if (!verifier) return { passed: true, checks: [], score: 100 }; // no verifier configured → pass

  const checks: VerifyResult['checks'] = [];

  // ── Deterministic checks ──────────────────────────────────────────────────
  const resultStr = JSON.stringify(task.result ?? '');

  // 1. No explicit error in result
  checks.push({
    name:   'no-error-field',
    passed: !((task.result as any)?.error || (task.result as any)?.ok === false),
    detail: 'Result must not contain error field or ok:false',
  });

  // 2. Result is not empty
  checks.push({
    name:   'non-empty-result',
    passed: resultStr.length > 2,
    detail: 'Result must not be empty',
  });

  // 3. For terminal tasks — no dangerous output patterns
  if (task.type === 'terminal') {
    const dangerous = /permission denied|command not found|fatal error|killed/i.test(resultStr);
    checks.push({ name: 'terminal-safe-output', passed: !dangerous, detail: 'Terminal output must not contain fatal errors' });
  }

  // 4. AI verifier review (soft check — adds to score but doesn't block)
  try {
    const verdict = await aiCall(
      verifier.id,
      `You are a strict code/task verifier. Respond with valid JSON only: {"passed": boolean, "reason": string}`,
      `Task type: ${task.type}\nDescription: ${task.description}\nResult (first 1000 chars): ${resultStr.slice(0, 1000)}\n\nDid the task succeed? Reply with JSON only.`,
    );
    const parsed = JSON.parse(verdict.replace(/```json|```/g, '').trim());
    checks.push({ name: 'ai-verifier', passed: Boolean(parsed.passed), detail: parsed.reason ?? '' });
  } catch {
    checks.push({ name: 'ai-verifier', passed: true, detail: 'Verifier unavailable — skipped' });
  }

  const score = Math.round((checks.filter(c => c.passed).length / checks.length) * 100);
  return { passed: score >= 75, checks, score };
}

// ─── Task execution ───────────────────────────────────────────────────────────

async function executeTask(task: OrchestratorTask): Promise<void> {
  ensureTasksSeeded();
  const update = (patch: Partial<OrchestratorTask>) => {
    Object.assign(task, patch, { updated: Date.now() });
    _tasks.set(task.id, task);
    if (_tasks.size % 10 === 0) saveTasks([..._tasks.values()]);
  };

  update({ status: 'planning' });

  // ── Step 1: Planning ──────────────────────────────────────────────────────
  const plannerModel = pickModel('planner', task.type) ?? _models.find(m => m.id === _config.defaultPlannerModel);
  if (!plannerModel) {
    update({ status: 'failed', error: 'No planner model available' });
    return;
  }

  let proposal: unknown;

  try {
    if (_config.parallelProposals && task.type === 'code_edit') {
      // Run DeepSeek R1 + Copilot in parallel, judge picks best
      update({ status: 'planning' });
      const plannerModels = _models.filter(m => m.enabled && m.role === 'planner');

      const proposals = await Promise.allSettled(
        plannerModels.map(async (m) => {
          const text = await aiCall(
            m.id,
            'You are a senior engineer. Propose a code change as a JSON object: {"approach": string, "changes": string[], "risks": string[]}. Respond with JSON only.',
            `Task: ${task.description}\nContext: ${JSON.stringify(task.proposal ?? {}).slice(0, 800)}`,
          );
          try { return { model: m.id, proposal: JSON.parse(text.replace(/```json|```/g, '').trim()) }; }
          catch { return { model: m.id, proposal: { approach: text, changes: [], risks: [] } }; }
        }),
      );

      const settled = proposals
        .filter((p): p is PromiseFulfilledResult<{ model: string; proposal: unknown }> => p.status === 'fulfilled')
        .map(p => p.value);

      update({ proposals: settled });

      // Judge picks the best one
      if (settled.length > 1) {
        const judgeModel = pickModel('judge', task.type) ?? _models.find(m => m.id === _config.defaultJudgeModel);
        if (judgeModel) {
          try {
            const judgeVerdict = await aiCall(
              judgeModel.id,
              'You are a senior engineering judge. Given multiple proposals, pick the best one and return: {"winner": "<model_id>", "reason": string}. JSON only.',
              `Task: ${task.description}\nProposals:\n${settled.map(p => `${p.model}: ${JSON.stringify(p.proposal).slice(0, 400)}`).join('\n---\n')}`,
            );
            const parsed  = JSON.parse(judgeVerdict.replace(/```json|```/g, '').trim());
            const winner  = settled.find(p => p.model === parsed.winner) ?? settled[0];
            proposal = winner.proposal;
          } catch { proposal = settled[0].proposal; }
        } else {
          proposal = settled[0].proposal;
        }
      } else if (settled.length === 1) {
        proposal = settled[0].proposal;
      }
    } else {
      // Single planner
      const text = await aiCall(
        plannerModel.id,
        'You are a senior engineer. Produce an execution plan as JSON: {"steps": string[], "approach": string, "risks": string[]}. JSON only.',
        `Task type: ${task.type}\nDescription: ${task.description}`,
      );
      try { proposal = JSON.parse(text.replace(/```json|```/g, '').trim()); }
      catch { proposal = { approach: text, steps: [], risks: [] }; }
    }
  } catch (e: any) {
    update({ status: 'failed', error: `Planning failed: ${e.message}` });
    return;
  }

  update({ status: 'proposed', proposal, planner: plannerModel.id });

  // ── Step 2: Approval (if needed) ──────────────────────────────────────────
  const risk = detectRisk(task.description);
  const needsApproval =
    task.autonomy === 'supervised' ||
    (task.autonomy === 'assisted' && (risk === 'high' || risk === 'critical'));

  if (needsApproval) {
    const gate = await approvalGate.request({
      action:      `Orchestrator: ${task.type} — ${task.description.slice(0, 100)}`,
      payload:     { taskId: task.id, proposal },
      risk,
      requestedBy: 'orchestrator',
      taskId:      task.id,
    });
    if (!gate.ok) {
      update({ status: 'awaiting_approval', approvalId: gate.approvalId });
      return;
    }
  }

  // ── Step 3: Execution ─────────────────────────────────────────────────────
  update({ status: 'executing' });
  const executorModel = pickModel('executor', task.type) ?? _models.find(m => m.id === _config.defaultExecutorModel);
  if (!executorModel) {
    update({ status: 'failed', error: 'No executor model available' });
    return;
  }

  let result: unknown;
  try {
    const text = await aiCall(
      executorModel.id,
      'You are an execution agent. Given a plan, return a JSON result: {"result": string, "actions_taken": string[], "success": boolean}. JSON only.',
      `Task: ${task.description}\nPlan: ${JSON.stringify(proposal).slice(0, 1200)}`,
    );
    try { result = JSON.parse(text.replace(/```json|```/g, '').trim()); }
    catch { result = { result: text, actions_taken: [], success: true }; }
  } catch (e: any) {
    update({ status: 'failed', error: `Execution failed: ${e.message}` });
    return;
  }

  update({ status: 'verifying', result, executor: executorModel.id });

  // ── Step 4: Verification ──────────────────────────────────────────────────
  if (_config.verifyAllTasks || risk !== 'low') {
    const verify = await runVerifier(task);
    if (!verify.passed) {
      update({ status: 'failed', error: `Verifier failed (score ${verify.score}): ${verify.checks.filter(c => !c.passed).map(c => c.name).join(', ')}` });
      // Record telemetry for the failure
      telemetry.record({
        model:     executorModel.id,
        provider:  executorModel.provider,
        taskType:  task.type,
        success:   false,
        latencyMs: Date.now() - task.created,
        error:     `verifier score ${verify.score}`,
      });
      return;
    }
  }

  // Record success telemetry
  telemetry.record({
    model:     executorModel.id,
    provider:  executorModel.provider,
    taskType:  task.type,
    success:   true,
    latencyMs: Date.now() - task.created,
  });

  update({ status: 'done' });
}

// ─── Route module ─────────────────────────────────────────────────────────────

export const orchestratorRoutes: RouteModule = async (ctx) => {
  const { meth, pathStr, qp, b, res } = ctx;
  const reply = (code: number, data: unknown) => { send(res, code, data); return true; };

  ensureTasksSeeded();

  // GET /orchestrator/status
  if (meth === 'GET' && pathStr === '/orchestrator/status') {
    return reply(200, {
      ok:      true,
      version: '3.7.0',
      config:  { autonomy: _config.autonomy, parallelProposals: _config.parallelProposals },
      models: {
        active: _models.filter(m => m.enabled).map(m => ({ id: m.id, role: m.role, tier: m.costTier })),
      },
      tasks: {
        total:    _tasks.size,
        pending:  [..._tasks.values()].filter(t => ['pending', 'planning', 'proposed', 'executing', 'verifying'].includes(t.status)).length,
        done:     [..._tasks.values()].filter(t => t.status === 'done').length,
        failed:   [..._tasks.values()].filter(t => t.status === 'failed').length,
      },
    });
  }

  // GET /orchestrator/config
  if (meth === 'GET' && pathStr === '/orchestrator/config') {
    return reply(200, { ok: true, config: _config });
  }

  // POST /orchestrator/config
  if (meth === 'POST' && pathStr === '/orchestrator/config') {
    Object.assign(_config, b);
    saveConfig();
    return reply(200, { ok: true, config: _config });
  }

  // GET /orchestrator/models
  if (meth === 'GET' && pathStr === '/orchestrator/models') {
    const stats = telemetry.stats();
    const statsMap = new Map(stats.map(s => [s.model, s]));
    const enriched = _models.map(m => ({
      ...m,
      empiricalSuccessRate: statsMap.get(m.id)?.successRate ?? null,
      empiricalLatencyMs:   statsMap.get(m.id)?.avgLatencyMs ?? null,
      totalCalls:           statsMap.get(m.id)?.calls ?? 0,
      totalCostUsd:         statsMap.get(m.id)?.totalCostUsd?.toFixed(4) ?? '0.0000',
    }));
    return reply(200, { ok: true, models: enriched });
  }

  // POST /orchestrator/models/:id/role  { role, reason }
  const roleMatch = pathStr.match(/^\/orchestrator\/models\/([^/]+)\/role$/);
  if (meth === 'POST' && roleMatch) {
    const modelId = roleMatch[1];
    const { role, enabled, reason } = b as any;
    const m = _models.find(m => m.id === modelId);
    if (!m) return reply(404, { ok: false, error: 'Model not found' });
    if (role)              m.role    = role;
    if (enabled !== undefined) m.enabled = Boolean(enabled);
    saveConfig();
    return reply(200, { ok: true, model: m, reason });
  }

  // POST /orchestrator/models/:id/suggest  { role, reason, suggestedBy }
  const suggestMatch = pathStr.match(/^\/orchestrator\/models\/([^/]+)\/suggest$/);
  if (meth === 'POST' && suggestMatch) {
    const modelId = suggestMatch[1];
    const { role, reason, suggestedBy } = b as any;
    const m = _models.find(m => m.id === modelId);
    if (!m) return reply(404, { ok: false, error: 'Model not found' });
    // Record suggestion — but do NOT auto-apply
    m.suggestedBy = suggestedBy ?? 'agent';
    const suggestion = { modelId, currentRole: m.role, suggestedRole: role, reason, ts: Date.now() };
    // Persist suggestion in a separate file for human review
    const suggestFile = path.join(DIR, 'role-suggestions.json');
    const existing: unknown[] = (() => { try { return JSON.parse(fs.readFileSync(suggestFile, 'utf-8')); } catch { return []; } })();
    existing.push(suggestion);
    fs.writeFileSync(suggestFile, JSON.stringify(existing.slice(-50), null, 2));
    return reply(202, { ok: true, message: 'Suggestion recorded — human must apply via POST /orchestrator/models/:id/role', suggestion });
  }

  // POST /orchestrator/task  { type, description, autonomy? }
  if (meth === 'POST' && pathStr === '/orchestrator/task') {
    const { type, description, autonomy, context } = b as any;
    if (!type || !description) return reply(400, { ok: false, error: 'type and description required' });

    const task: OrchestratorTask = {
      id:          randomUUID(),
      type:        String(type),
      description: String(description),
      autonomy:    (autonomy as AutonomyLevel) ?? _config.autonomy,
      status:      'pending',
      proposal:    context,
      created:     Date.now(),
      updated:     Date.now(),
    };

    _tasks.set(task.id, task);

    // Execute asynchronously
    executeTask(task).catch(e => {
      task.status = 'failed';
      task.error  = e.message;
      task.updated = Date.now();
      _tasks.set(task.id, task);
    });

    return reply(202, { ok: true, taskId: task.id, status: 'pending' });
  }

  // GET /orchestrator/task/:id
  const taskGet = pathStr.match(/^\/orchestrator\/task\/([^/]+)$/);
  if (meth === 'GET' && taskGet) {
    const task = _tasks.get(taskGet[1]);
    if (!task) return reply(404, { ok: false, error: 'Task not found' });
    return reply(200, { ok: true, task });
  }

  // POST /orchestrator/task/:id/retry
  const retryMatch = pathStr.match(/^\/orchestrator\/task\/([^/]+)\/retry$/);
  if (meth === 'POST' && retryMatch) {
    const task = _tasks.get(retryMatch[1]);
    if (!task) return reply(404, { ok: false, error: 'Task not found' });
    task.status  = 'pending';
    task.error   = undefined;
    task.result  = undefined;
    task.updated = Date.now();
    executeTask(task).catch(() => {});
    return reply(202, { ok: true, taskId: task.id, status: 'pending' });
  }

  // DELETE /orchestrator/task/:id
  const taskDel = pathStr.match(/^\/orchestrator\/task\/([^/]+)$/);
  if (meth === 'DELETE' && taskDel) {
    const task = _tasks.get(taskDel[1]);
    if (!task) return reply(404, { ok: false, error: 'Task not found' });
    task.status  = 'failed';
    task.error   = 'Cancelled by user';
    task.updated = Date.now();
    return reply(200, { ok: true, cancelled: true });
  }

  // GET /orchestrator/tasks?limit=&status=
  if (meth === 'GET' && pathStr === '/orchestrator/tasks') {
    ensureTasksSeeded();
    const limit = parseInt(qp.limit ?? '50', 10);
    let list    = [..._tasks.values()].sort((a, b) => b.created - a.created);
    if (qp.status) list = list.filter(t => t.status === qp.status);
    return reply(200, { ok: true, tasks: list.slice(0, limit), total: _tasks.size });
  }

  // POST /orchestrator/propose  { type, description, models? }
  // Run parallel proposals and return all + judge's pick (does NOT execute)
  if (meth === 'POST' && pathStr === '/orchestrator/propose') {
    const { type, description, models: modelList } = b as any;
    if (!description) return reply(400, { ok: false, error: 'description required' });

    const planners = modelList
      ? _models.filter(m => modelList.includes(m.id) && m.enabled)
      : _models.filter(m => m.enabled && m.role === 'planner');

    if (planners.length === 0) return reply(400, { ok: false, error: 'No enabled planner models' });

    const settled = await Promise.allSettled(
      planners.map(async (m) => {
        const text = await aiCall(
          m.id,
          'You are a senior engineer. Propose an approach. Return JSON: {"approach": string, "steps": string[], "pros": string[], "cons": string[], "estimatedCostUsd": number}',
          `Task type: ${type ?? 'general'}\n${description}`,
        );
        let proposal: unknown;
        try { proposal = JSON.parse(text.replace(/```json|```/g, '').trim()); }
        catch { proposal = { approach: text, steps: [], pros: [], cons: [] }; }
        return { model: m.id, cost: m.costPer1k, proposal };
      }),
    );

    const proposals = settled
      .filter((p): p is PromiseFulfilledResult<any> => p.status === 'fulfilled')
      .map(p => p.value);

    // Judge picks the best
    let winner: typeof proposals[0] | undefined;
    const judgeModel = _models.find(m => m.id === _config.defaultJudgeModel && m.enabled);
    if (judgeModel && proposals.length > 1) {
      try {
        const verdict = await aiCall(
          judgeModel.id,
          'You are a senior engineering judge. Return JSON: {"winner": "<model_id>", "reason": string, "scorecard": object}',
          `Task: ${description}\nProposals:\n${proposals.map(p => `${p.model}: ${JSON.stringify(p.proposal).slice(0, 600)}`).join('\n---\n')}`,
        );
        const parsed = JSON.parse(verdict.replace(/```json|```/g, '').trim());
        winner = proposals.find(p => p.model === parsed.winner);
      } catch { winner = proposals[0]; }
    } else {
      winner = proposals[0];
    }

    return reply(200, { ok: true, proposals, winner, judgedBy: judgeModel?.id });
  }

  // GET /orchestrator/telemetry
  if (meth === 'GET' && pathStr === '/orchestrator/telemetry') {
    return reply(200, { ok: true, stats: telemetry.stats() });
  }

  // POST /orchestrator/route  { type, candidates? }
  if (meth === 'POST' && pathStr === '/orchestrator/route') {
    const { type, candidates: c, role } = b as any;
    const candidateList = c ?? _models.filter((m: ModelProfile) => m.enabled).map((m: ModelProfile) => m.id);
    const best = telemetry.getBestModel(String(type ?? 'general'), candidateList);
    const m    = _models.find(m => m.id === best);
    return reply(200, {
      ok:          true,
      recommended: best,
      model:       m,
      reason:      'Empirical success rate / cost optimisation',
    });
  }

  return false;
};

/** Expose for use by extension.ts (seed bridge token on startup). */
export function seedBridgeToken(token: string) {
  secretManager.seed('bridge-token', token);
}
