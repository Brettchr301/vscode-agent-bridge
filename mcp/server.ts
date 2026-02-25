#!/usr/bin/env node
/**
 * VS Code Agent Bridge — MCP stdio server
 *
 * Implements JSON-RPC 2.0 over stdin/stdout so Claude Desktop, Cursor,
 * and any MCP-compatible client can control VS Code via the HTTP bridge.
 *
 * Add to Claude Desktop's mcp.json:
 *   {
 *     "mcpServers": {
 *       "vscode-agent-bridge": {
 *         "command": "node",
 *         "args": ["<path-to-extension>/mcp/server.js"]
 *       }
 *     }
 *   }
 */
import * as http     from 'http';
import * as readline from 'readline';

const BRIDGE_PORT = process.env.AGENT_BRIDGE_PORT
  ? parseInt(process.env.AGENT_BRIDGE_PORT, 10)
  : 3131;

const AUTH_TOKEN = process.env.AGENT_BRIDGE_TOKEN ?? '';

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function bridgeGet(endpoint: string, params: Record<string, string> = {}): Promise<unknown> {
  const qs = Object.keys(params).length
    ? '?' + new URLSearchParams(params).toString()
    : '';
  return request('GET', endpoint + qs, undefined);
}

function bridgePost(endpoint: string, body: unknown): Promise<unknown> {
  return request('POST', endpoint, JSON.stringify(body));
}

function request(method: string, path: string, reqBody?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: BRIDGE_PORT,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(AUTH_TOKEN ? { 'Authorization': `Bearer ${AUTH_TOKEN}` } : {}),
        ...(reqBody ? { 'Content-Length': Buffer.byteLength(reqBody) } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    if (reqBody) req.write(reqBody);
    req.end();
  });
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

const TOOLS: ToolDef[] = [
  // ── Health / info ──
  {
    name: 'health',
    description: 'Check bridge status, available Copilot models, and current workspace.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'workspace_info',
    description: 'Get open workspace folders, active file, language, selection, and all open documents.',
    inputSchema: { type: 'object', properties: {} },
  },
  // ── Filesystem ──
  {
    name: 'read_file',
    description: 'Read the full text of any file on disk.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description: 'List files and subdirectories inside a directory.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute directory path.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write (overwrite) a file with new content.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path.' },
        content: { type: 'string', description: 'Text content to write.' },
        create_dirs: { type: 'boolean', description: 'Create parent directories if missing (default true).' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'apply_edit',
    description: 'Replace an exact string in a file (search-and-replace).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path.' },
        old_text: { type: 'string', description: 'Exact text to find and replace.' },
        new_text: { type: 'string', description: 'Replacement text.' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'insert_text',
    description: 'Insert text at a specific position in the active editor.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to insert.' },
        path: { type: 'string', description: 'File to open (optional).' },
        line: { type: 'number', description: '1-based line number (optional).' },
        column: { type: 'number', description: '0-based column (optional).' },
      },
      required: ['text'],
    },
  },
  // ── Git ──
  {
    name: 'git_status',
    description: 'Get current branch, last commit, staged/unstaged file counts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'git_commit',
    description: 'Stage all changes and create a git commit.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Commit message.' },
        add_all: { type: 'boolean', description: 'Stage all files before committing (default true).' },
        cwd: { type: 'string', description: 'Working directory (defaults to workspace root).' },
      },
      required: ['message'],
    },
  },
  {
    name: 'git_push',
    description: 'Push local commits to a remote.',
    inputSchema: {
      type: 'object',
      properties: {
        remote: { type: 'string', description: 'Remote name (default: origin).' },
        branch: { type: 'string', description: 'Branch to push (default: current).' },
        cwd: { type: 'string', description: 'Working directory.' },
      },
    },
  },
  {
    name: 'git_diff',
    description: 'Get the full unstaged (or staged) diff of the repository.',
    inputSchema: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: 'Return staged diff instead of unstaged.' },
      },
    },
  },
  // ── Terminal ──
  {
    name: 'run_terminal',
    description: 'Run a shell command in VS Code. Set capture_output:true to get stdout back.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run.' },
        cwd: { type: 'string', description: 'Working directory.' },
        capture_output: { type: 'boolean', description: 'Return stdout/stderr instead of opening a visible terminal.' },
        timeout: { type: 'number', description: 'Timeout in seconds (default 120).' },
      },
      required: ['command'],
    },
  },
  {
    name: 'exec_command',
    description: 'Execute a built-in VS Code command by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'VS Code command ID.' },
        args: { type: 'string', description: 'JSON array of arguments.' },
      },
      required: ['command'],
    },
  },
  // ── Editor ──
  {
    name: 'open_file',
    description: 'Open a file in the VS Code editor, optionally scrolling to a line.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path.' },
        line: { type: 'number', description: '1-based line to reveal.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'save_all',
    description: 'Save all unsaved documents.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'show_message',
    description: 'Show a notification inside VS Code.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message text.' },
        level: { type: 'string', description: '"info" | "warn" | "error".' },
      },
      required: ['message'],
    },
  },
  {
    name: 'format_file',
    description: 'Run the VS Code formatter on a file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path (uses active editor if omitted).' },
      },
    },
  },
  {
    name: 'symbols',
    description: 'List functions, classes, and variables in a file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path (uses active editor if omitted).' },
      },
    },
  },
  {
    name: 'rename_symbol',
    description: 'Open the rename dialog for a symbol.',
    inputSchema: {
      type: 'object',
      properties: {
        old_name: { type: 'string', description: 'Current symbol name.' },
        new_name: { type: 'string', description: 'New name.' },
        path: { type: 'string', description: 'File containing the symbol.' },
      },
      required: ['old_name', 'new_name'],
    },
  },
  // ── Workspace / diagnostics ──
  {
    name: 'diagnostics',
    description: 'Get TypeScript/ESLint errors and warnings for a file or the whole workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to scope results (all files if omitted).' },
      },
    },
  },
  {
    name: 'changes_since',
    description: 'List files changed since a Unix-millisecond timestamp.',
    inputSchema: {
      type: 'object',
      properties: {
        ts: { type: 'number', description: 'Unix timestamp in ms (use 0 for all).' },
      },
      required: ['ts'],
    },
  },
  {
    name: 'search_workspace',
    description: 'Regex/text search across all workspace files. Returns matching lines.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex or text pattern.' },
        path_glob: { type: 'string', description: 'Glob filter e.g. "**/*.ts".' },
        max_results: { type: 'number', description: 'Max lines to return (default 200).' },
        case_sensitive: { type: 'boolean', description: 'Case-sensitive search (default false).' },
      },
      required: ['pattern'],
    },
  },
  // ── Copilot ──
  {
    name: 'prompt',
    description: 'Send a prompt to GitHub Copilot and get a text response.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The user prompt.' },
        system: { type: 'string', description: 'Optional system message.' },
        model: { type: 'string', description: 'Model family hint e.g. "claude-sonnet-4".' },
        timeout: { type: 'number', description: 'Timeout in seconds (default 300).' },
        context_files: { type: 'string', description: 'JSON array of file paths to inject as context.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'copilot_task',
    description: 'Ask Copilot to perform a full coding task: prompts, watches for edits, and auto-accepts them.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Task description.' },
        auto_accept: { type: 'boolean', description: 'Auto-accept edits (default true).' },
        watch_secs: { type: 'number', description: 'Seconds to watch for file changes (default 60).' },
        timeout: { type: 'number', description: 'Copilot timeout seconds (default 300).' },
      },
      required: ['prompt'],
    },
  },
  // ── System ──
  {
    name: 'get_clipboard',
    description: 'Read the current clipboard text.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_clipboard',
    description: 'Write text to the clipboard.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to copy.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'processes',
    description: 'List running processes (name, PID, CPU, memory).',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Name substring filter.' },
      },
    },
  },
  {
    name: 'kill_process',
    description: 'Terminate a process by name or PID.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Process name.' },
        pid: { type: 'number', description: 'Process ID.' },
        force: { type: 'boolean', description: 'Force kill (default true).' },
      },
    },
  },
  {
    name: 'notify',
    description: 'Show a Windows toast notification.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Notification body.' },
        title: { type: 'string', description: 'Notification title (default "Agent Bridge").' },
      },
      required: ['message'],
    },
  },
  {
    name: 'http_proxy',
    description: 'Make an outbound HTTP/HTTPS request on behalf of the agent.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Target URL.' },
        method: { type: 'string', description: 'HTTP method (default GET).' },
        headers: { type: 'string', description: 'JSON object of request headers.' },
        body: { type: 'string', description: 'Request body string.' },
      },
      required: ['url'],
    },
  },
  // ── Approval / watch ──
  {
    name: 'accept_edits',
    description: 'Accept all pending Copilot inline edits and save all files.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'reject_edits',
    description: 'Reject / discard all pending Copilot inline edits.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'keep_going',
    description: 'Click any "Continue / Keep / Accept / Allow" dialog or notification.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'auto_dismiss',
    description: 'Start or stop a background loop that continuously clicks Allow/Continue dialogs.',
    inputSchema: {
      type: 'object',
      properties: {
        active: { type: 'boolean', description: 'true to start, false to stop.' },
        interval_ms: { type: 'number', description: 'Poll interval in ms (default 1500).' },
      },
      required: ['active'],
    },
  },
  {
    name: 'watch_start',
    description: 'Start a watch session to track file changes from this moment.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Descriptive label for this session.' },
      },
    },
  },
  {
    name: 'watch_result',
    description: 'Get the list of files changed since a watch session started.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'watch_id returned by watch_start.' },
      },
      required: ['id'],
    },
  },
  // ── Slack ──
  {
    name: 'slack_post',
    description: 'Post a message to Slack using the stored bot token.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message text.' },
        channel: { type: 'string', description: 'Channel ID (uses configured default if omitted).' },
      },
      required: ['text'],
    },
  },
  // ── Config ──
  {
    name: 'get_config',
    description: 'Read the bridge config file (~/.agent-bridge/config.json). Sensitive keys are redacted.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_log',
    description: 'Retrieve the last 100 HTTP request log entries from the bridge.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ─── Tool dispatcher ──────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'health':          return bridgeGet('/health');
    case 'workspace_info':  return bridgeGet('/workspace-info');

    case 'read_file':       return bridgeGet('/read-file',  { path: String(args.path ?? '') });
    case 'list_dir':        return bridgeGet('/list-dir',   { path: String(args.path ?? '') });
    case 'write_file':      return bridgePost('/write-file', args);
    case 'apply_edit':      return bridgePost('/apply-edit', args);
    case 'insert_text':     return bridgePost('/insert-text', args);

    case 'git_status':      return bridgeGet('/git-status');
    case 'git_commit':      return bridgePost('/git-commit', args);
    case 'git_push':        return bridgePost('/git-push', args);
    case 'git_diff':        return bridgeGet('/git-diff', args.staged ? { staged: '1' } : {});

    case 'run_terminal':    return bridgePost('/run-terminal', args);
    case 'exec_command':    return bridgePost('/exec-command', {
      command: args.command,
      args: args.args ? JSON.parse(String(args.args)) : [],
    });

    case 'open_file':       return bridgePost('/open-file', args);
    case 'save_all':        return bridgePost('/save-all', {});
    case 'show_message':    return bridgePost('/show-message', args);
    case 'format_file':     return bridgePost('/format-file', args);
    case 'symbols':         return bridgeGet('/symbols', args.path ? { path: String(args.path) } : {});
    case 'rename_symbol':   return bridgePost('/rename-symbol', args);

    case 'diagnostics':     return bridgeGet('/diagnostics', args.path ? { path: String(args.path) } : {});
    case 'changes_since':   return bridgeGet('/changes-since', { ts: String(args.ts ?? 0) });
    case 'search_workspace':return bridgePost('/search-workspace', args);

    case 'prompt':          return bridgePost('/prompt', {
      ...args,
      context_files: args.context_files ? JSON.parse(String(args.context_files)) : undefined,
    });
    case 'copilot_task':    return bridgePost('/copilot-task', args);

    case 'get_clipboard':   return bridgeGet('/clipboard');
    case 'set_clipboard':   return bridgePost('/clipboard', args);
    case 'processes':       return bridgeGet('/processes', args.filter ? { filter: String(args.filter) } : {});
    case 'kill_process':    return bridgePost('/kill-process', args);
    case 'notify':          return bridgePost('/notify', args);
    case 'http_proxy':      return bridgePost('/http-proxy', {
      ...args,
      headers: args.headers ? JSON.parse(String(args.headers)) : undefined,
    });

    case 'accept_edits':    return bridgePost('/accept-edits', {});
    case 'reject_edits':    return bridgePost('/reject-edits', {});
    case 'keep_going':      return bridgePost('/keep-going', {});
    case 'auto_dismiss':    return bridgePost('/auto-dismiss', args);
    case 'watch_start':     return bridgePost('/watch-start', args);
    case 'watch_result':    return bridgeGet('/watch-result', { id: String(args.id ?? '') });

    case 'slack_post':      return bridgePost('/slack-post', args);
    case 'get_config':      return bridgeGet('/config');
    case 'get_log':         return bridgeGet('/log');

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── JSON-RPC 2.0 server ──────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: string;
  id: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function respond(id: number | string | null, result: unknown) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
}

function error(id: number | string | null, code: number, message: string) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(msg + '\n');
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;

  let req: JsonRpcRequest;
  try {
    req = JSON.parse(line);
  } catch {
    error(null, -32700, 'Parse error');
    return;
  }

  const { id, method, params = {} } = req;

  try {
    switch (method) {
      case 'initialize':
        respond(id, {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'vscode-agent-bridge', version: '3.4.0' },
          capabilities: { tools: {} },
        });
        break;

      case 'notifications/initialized':
        // no response needed for notifications
        break;

      case 'ping':
        respond(id, {});
        break;

      case 'tools/list':
        respond(id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
        break;

      case 'tools/call': {
        const toolName = String((params as { name?: string }).name ?? '');
        const toolArgs = ((params as { arguments?: Record<string, unknown> }).arguments) ?? {};
        const result = await callTool(toolName, toolArgs);
        respond(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
        break;
      }

      default:
        error(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    error(id, -32000, String(e));
  }
});

rl.on('close', () => process.exit(0));
