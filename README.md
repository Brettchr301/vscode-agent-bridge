# VS Code Agent Bridge

A local HTTP bridge that gives any AI agent **full programmatic control** over VS Code, GitHub Copilot, the local filesystem, terminal, git, clipboard, processes, and Slack — all running entirely on your machine.

---

## What it does

Starts a lightweight HTTP server on `127.0.0.1:3131` the moment VS Code opens. Your AI agent (DeepSeek, a Python script, n8n, Make, etc.) can then:

- **Prompt Copilot** directly and get the response as JSON
- **Write, read, edit files** on your disk
- **Run terminal commands** and capture their output
- **Git operations** — status, diff, commit, push
- **Search workspace** — regex/text grep across all files
- **Clipboard** — read and write
- **Process management** — list + kill processes
- **Outbound HTTP proxy** — make HTTP/HTTPS requests through the bridge
- **Code symbols** — get function/class outline for any file
- **Auto-dismiss** Allow / Continue / Keep dialogs automatically
- **Post to Slack** when tasks complete
- **Windows toast notifications**
- **Schedule commands** to run after a delay
- **Type into any desktop app** via WScript.Shell (Windows)

Everything stays 100% local. Only the LLM inference call leaves your machine (to Copilot's cloud endpoint).

---

## Quick Start

### 1. Install

**Option A — From source:**
```bash
git clone https://github.com/Brettchr301/vscode-agent-bridge.git
cd vscode-agent-bridge
npm install
npm run compile
# Then in VS Code: Extensions > Install from VSIX... or press F5 to run in debug
```

**Option B — From VSIX:**
Download the latest `.vsix` from [Releases](https://github.com/YOUR_USERNAME/vscode-agent-bridge/releases) and install via:
```
code --install-extension vscode-agent-bridge-1.0.0.vsix
```

### 2. Verify it's running

After VS Code loads, look for `$(broadcast) Bridge :3131` in the status bar.

```powershell
# Quick health check
Invoke-RestMethod http://127.0.0.1:3131/health
```

You should see `ok: true`, the port, and a list of available Copilot models.

### 3. Configure (optional)
Open VS Code Settings (`Ctrl+,`) and search for **Agent Bridge**:

| Setting | Default | Purpose |
|---|---|---|
| `agentBridge.port` | `3131` | Bridge port |
| `agentBridge.slackBotToken` | *(empty)* | `xoxb-...` token for `/slack-post` |
| `agentBridge.slackChannel` | *(empty)* | Default Slack channel |
| `agentBridge.autoDismissOnStartup` | `false` | Auto-start dialog poking loop |
| `agentBridge.maxPromptTimeout` | `300` | Seconds before LLM calls time out |

---

## MCP Server

The extension ships a standalone **MCP (Model Context Protocol) stdio server** so you can connect Claude Desktop, Cursor, and any other MCP-compatible client directly — no HTTP knowledge required.

### Setup — Claude Desktop

1. Find the compiled server at `<extension-folder>/out/mcp/server.js`
   - Extension folder is usually `~/.vscode/extensions/brettco.vscode-agent-bridge-*/`
2. Add to `~/AppData/Roaming/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vscode-agent-bridge": {
      "command": "node",
      "args": [
        "C:\\Users\\YOU\\.vscode\\extensions\\brettco.vscode-agent-bridge-3.4.0\\out\\mcp\\server.js"
      ]
    }
  }
}
```

3. Restart Claude Desktop — you'll find **35+ VS Code tools** in every conversation.

### Setup — Cursor / other MCP clients

Add to your MCP config (`.cursor/mcp.json` or equivalent):

```json
{
  "servers": {
    "vscode-agent-bridge": {
      "command": "node",
      "args": ["<path-to-extension>/out/mcp/server.js"]
    }
  }
}
```

### Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_BRIDGE_PORT` | `3131` | Bridge port if you changed it |
| `AGENT_BRIDGE_TOKEN` | *(empty)* | Bearer token if auth is enabled |

### Available MCP Tools (35+)

| Category | Tools |
|---|---|
| Health / Info | `health`, `workspace_info` |
| Filesystem | `read_file`, `list_dir`, `write_file`, `apply_edit`, `insert_text` |
| Git | `git_status`, `git_commit`, `git_push`, `git_diff` |
| Terminal | `run_terminal`, `exec_command` |
| Editor | `open_file`, `save_all`, `show_message`, `format_file`, `symbols`, `rename_symbol` |
| Workspace | `diagnostics`, `changes_since`, `search_workspace` |
| Copilot | `prompt`, `copilot_task` |
| System | `get_clipboard`, `set_clipboard`, `processes`, `kill_process`, `notify`, `http_proxy` |
| Approvals | `accept_edits`, `reject_edits`, `keep_going`, `auto_dismiss` |
| Watch | `watch_start`, `watch_result` |
| Slack | `slack_post` |
| Config | `get_config`, `get_log` |

---

## API Reference

All endpoints are on `http://127.0.0.1:3131`. All POST bodies are JSON.

### Core

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/health` | — | `{ok, port, version, models[], workspace}` |
| GET | `/workspace-info` | — | `{ok, folders[], active_file}` |

### Copilot / LLM

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/prompt` | `{prompt, model?, system?, timeout?, context_files?}` | `{ok, text, model_used, elapsed_ms}` |
| POST | `/copilot-task` | `{prompt, auto_accept?, watch_secs?, timeout?, context_files?}` | `{ok, llm_response, files_changed[], diff_summary[]}` |

**`/copilot-task`** is the power endpoint — it prompts Copilot, **automatically clicks any Allow/Continue dialogs** while it runs, waits for file changes, then returns a full diff summary.

### Filesystem

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/read-file?path=` | — | `{ok, content, lines}` |
| GET | `/list-dir?path=` | — | `{ok, entries[]}` |
| POST | `/write-file` | `{path, content, create_dirs?}` | `{ok, bytes}` |
| POST | `/apply-edit` | `{path, old_text, new_text}` | `{ok}` |

### Terminal

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/run-terminal` | `{command, cwd?, capture_output?}` | `{ok, terminal_name}` or `{ok, stdout, stderr, exit_code}` |

Set `capture_output: true` to get stdout/stderr back without a visible terminal window.

### Editor

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/open-file` | `{path, line?}` | `{ok, lines}` |
| GET | `/diagnostics?path=` | — | `{ok, errors[], warnings[]}` |
| POST | `/exec-command` | `{command, args?}` | `{ok, result}` |

### Dialog Auto-Dismiss

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/keep-going` | — | `{ok, commands_run[]}` |
| POST | `/auto-dismiss` | `{active: true\|false, interval_ms?}` | `{ok, active}` |
| GET | `/auto-dismiss` | — | `{ok, active}` |

### Change Tracking

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| POST | `/watch-start` | `{label?}` | `{ok, watch_id}` |
| GET | `/watch-result?id=` | — | `{ok, files[]}` |
| GET | `/changes-since?ts=` | — | `{ok, files[]}` |
| GET | `/pending-approvals` | — | `{ok, count, files[]}` |
| POST | `/accept-edits` | — | `{ok}` |
| POST | `/reject-edits` | — | `{ok}` |

### Integrations

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/slack-post` | `{text, channel?}` | `{ok, channel}` |
| POST | `/desktop-type` | `{app, text, window_title?, delay_ms?}` | `{ok}` |
| POST | `/show-message` | `{message, level?}` | `{ok}` |
| GET | `/log` | — | `{ok, entries[]}` |

---

## Python Agent Template

See [`agent_template.py`](agent_template.py) for a ready-to-use Python class that wraps the bridge. Basic usage:

```python
from agent_template import AgentBridge

bridge = AgentBridge()  # auto-detects port

# Ask Copilot something
answer = bridge.prompt("What does this function do?", context_files=["src/main.py"])
print(answer)

# Full task: write + run a script
result = bridge.copilot_task(
    "Write a Python script that prints system info. Save to /tmp/sysinfo.py",
    auto_accept=True
)
bridge.run_terminal("python /tmp/sysinfo.py", capture_output=True)

# Post result to Slack
bridge.slack_post(f"Done! Changed files: {result['files_changed']}")
```

---

## IoT Device Control

Connect your AI / Copilot to any smart home device. Devices are stored in `~/.agent-bridge/iot-devices.json`.

### Supported device types

| Type | What it connects to |
|---|---|
| `homeassistant` | Home Assistant instance (all 3,000+ integrations it supports) |
| `roomba` | iRobot Roomba via Home Assistant |
| `hue` | Philips Hue bridge (lights) |
| `shelly` | Shelly smart plugs, dimmers, relays — local HTTP |
| `tasmota` | Any Tasmota-flashed device — local HTTP |
| `esphome` | ESPHome devices — local REST API |
| `wled` | WLED LED strip controllers |
| `tuya` | Tuya / Smart Life cloud API |
| `mqtt` | Any MQTT broker — publishes via `mosquitto_pub` |
| `rest` | Generic REST device — you define the endpoints |

### Register a device

```bash
# Register Home Assistant
curl -X POST http://127.0.0.1:3131/iot/devices \
  -H "Content-Type: application/json" \
  -d '{"name":"Home HA","type":"homeassistant","host":"192.168.1.10","port":8123,"token":"<HA_LONG_LIVED_TOKEN>"}'

# Register a Roomba (via HA) — include which rooms map to which HA zone IDs
curl -X POST http://127.0.0.1:3131/iot/devices \
  -H "Content-Type: application/json" \
  -d '{
    "name":"Roomba",
    "type":"roomba",
    "host":"192.168.1.10",
    "port":8123,
    "token":"<HA_TOKEN>",
    "meta":{"entity_id":"vacuum.roomba","rooms":{"kitchen":"1","bedroom":"2","lounge":"3"}}
  }'

# Register a Shelly plug
curl -X POST http://127.0.0.1:3131/iot/devices \
  -d '{"name":"Dryer Plug","type":"shelly","host":"192.168.1.55"}'
```

### Control devices

```bash
# Natural-language command (no API knowledge needed)
curl -X POST http://127.0.0.1:3131/iot/command \
  -d '{"text":"turn off the living room lights"}'

# Or via an AI agent / Slack message:
POST /iot/command  {"text": "start the roomba"}
POST /iot/command  {"text": "set bedroom lights blue"}
POST /iot/command  {"text": "turn off the dryer plug"}

# Direct control
POST /iot/control  {"id":"home-ha","action":"light.turn_on","params":{"entity_id":"light.kitchen","brightness":200}}
POST /iot/control  {"id":"dryer-plug","action":"turn_off"}
GET  /iot/status?id=roomba

# Discover devices on your LAN automatically
GET  /iot/discover?subnet=192.168.1.1
```

---

## Room Presence Tracking

Track which rooms people are in — then let the AI use that data to make smart decisions (e.g. have the Roomba avoid occupied rooms).

### How it works

**Phone ping detection** — the bridge pings your phone's local IP. If it replies, you're home.  
**Manual room check-in** — call `/presence/checkin` from an iOS Shortcut, Tasker task, or NFC tag when you enter a room.  
**AI / Slack command** — tell the AI "I'm in the kitchen" and it calls the check-in API automatically.

### Setup

```bash
# 1. Register your phone (find your phone's local IP in WiFi settings)
curl -X POST http://127.0.0.1:3131/presence/phones \
  -d '{"person":"Brett","name":"Brett iPhone","ip":"192.168.1.42","mac":"aa:bb:cc:dd:ee:ff","room":"lounge"}'

# 2. Scan to detect who is home
curl -X POST http://127.0.0.1:3131/presence/scan

# 3. Check current occupancy
curl http://127.0.0.1:3131/presence/rooms
```

### iOS Shortcuts / Tasker automation

Create a shortcut that runs when you connect to a specific WiFi network or scan an NFC tag:

```
POST http://192.168.1.YourPC:3131/presence/checkin
{"person":"Brett","room":"kitchen"}
```

Add a matching shortcut on leaving:

```
POST http://192.168.1.YourPC:3131/presence/checkout
{"person":"Brett","room":"kitchen"}
```

### Roomba + presence integration

```bash
# Start Roomba, but skip any rooms you're currently in
curl -X POST http://127.0.0.1:3131/iot/roomba/avoid-occupied \
  -d '{"id":"roomba"}'
```

This automatically:
1. Reads current room occupancy from presence tracking
2. Finds empty rooms from the Roomba's room map
3. Starts a targeted clean of only the unoccupied rooms

### Via Slack / AI chat

Because every IoT and presence endpoint is exposed over HTTP and MCP, you can just ask your AI in Slack:

```
You: "Start the roomba but avoid my bedroom, I'm working in there"
AI: calls POST /presence/checkin {"person":"Brett","room":"bedroom"}
    then POST /iot/roomba/avoid-occupied {"id":"roomba"}
    → Roomba cleans kitchen, lounge, office — skips bedroom ✓

You: "Turn off all the lights"
AI: calls POST /iot/command {"text":"turn off all lights"}
    → All registered light devices turned off ✓
```

### Presence API reference

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/presence/rooms` | — | `{occupied_rooms[], map, anyone_home}` |
| GET | `/presence/who-is-home` | — | `{people[{person,rooms[],last_seen}]}` |
| GET | `/presence/is-room-clear?room=` | — | `{room, clear, occupants[]}` |
| POST | `/presence/checkin` | `{person, room}` | `{current_rooms[]}` |
| POST | `/presence/checkout` | `{person, room?}` | `{current_rooms[]}` |
| POST | `/presence/scan` | — | `{results[], occupied_rooms[]}` |
| GET | `/presence/phones` | — | `{phones[]}` |
| POST | `/presence/phones` | `{person, ip, name?, mac?, room?}` | `{phone}` |

---

## Slack Setup

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create App → From Scratch
2. Add **Bot Token Scopes**: `chat:write`, `chat:write.public`
3. Install to workspace → copy the `xoxb-...` Bot Token
4. Set in VS Code settings: `agentBridge.slackBotToken`
5. Set your channel: `agentBridge.slackChannel` (use the channel ID from Slack, e.g. `C0XXXXXXX`)

---

## Security Notes

- The bridge **only listens on 127.0.0.1** — it is not reachable from the network
- Never commit your Slack token — use VS Code settings (stored in OS keychain on Windows)
- The `/run-terminal` endpoint can run any command — only give your own agents access to the bridge port
- You can restrict which agents can reach it by firewall-blocking port 3131 to specific PIDs

---

## Supported Platforms

- **Windows** ✅ (primary — `/desktop-type` uses WScript.Shell)
- **macOS** ✅ (`/desktop-type` will use AppleScript in a future release)
- **Linux** ✅ (without `/desktop-type`)

---

## License

MIT — free to use, modify, and redistribute.
