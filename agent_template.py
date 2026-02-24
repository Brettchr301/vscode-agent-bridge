"""
VS Code Agent Bridge — Python client template
=============================================
Drop this file into your agent project and import AgentBridge.

Usage:
    from agent_template import AgentBridge

    bridge = AgentBridge()          # auto-discovers port (3131–3134)
    print(bridge.health())          # {'ok': True, 'version': '...', ...}
    print(bridge.prompt("Say hi"))  # 'Hello! ...'

Configure your Slack token in VS Code settings (agentBridge.slackBotToken)
or in a sidecar file at ~/Documents/AgentBridgeConfig/settings.json:
    { "slack_bot_token": "xoxb-...", "slack_channel": "C0XXXXXXX" }
"""

import json
import http.client
import time
from typing import Any


# ── Configuration ──────────────────────────────────────────────────────────────

BRIDGE_PORTS   = [3131, 3132, 3133, 3134]
BRIDGE_HOST    = "127.0.0.1"
DEFAULT_TIMEOUT = 300          # seconds for LLM calls
POLL_INTERVAL   = 2.0          # seconds between status polls


# ── Core client ────────────────────────────────────────────────────────────────

class AgentBridge:
    """
    Thin Python wrapper around the VS Code Agent Bridge HTTP API.
    All methods raise BridgeError on HTTP/network failure.
    """

    def __init__(self, host: str = BRIDGE_HOST, port: int | None = None):
        self.host = host
        self.port = port or self._discover_port()

    # ── Internal helpers ──────────────────────────────────────────────────

    def _discover_port(self) -> int:
        for p in BRIDGE_PORTS:
            try:
                data = self._raw_get(p, "/health")
                if data.get("ok"):
                    return p
            except Exception:
                pass
        raise BridgeError(f"No bridge found on ports {BRIDGE_PORTS}. Is VS Code running with the extension?")

    def _conn(self) -> http.client.HTTPConnection:
        return http.client.HTTPConnection(self.host, self.port, timeout=DEFAULT_TIMEOUT + 10)

    def _raw_get(self, port: int, path: str) -> dict:
        c = http.client.HTTPConnection(self.host, port, timeout=10)
        c.request("GET", path)
        return json.loads(c.getresponse().read())

    def _get(self, path: str) -> dict:
        c = self._conn()
        c.request("GET", path)
        resp = c.getresponse()
        data = json.loads(resp.read())
        c.close()
        if not data.get("ok") and resp.status >= 400:
            raise BridgeError(f"GET {path} failed: {data.get('error', data)}")
        return data

    def _post(self, path: str, body: dict, timeout: int = DEFAULT_TIMEOUT) -> dict:
        payload = json.dumps(body).encode()
        c = http.client.HTTPConnection(self.host, self.port, timeout=timeout + 10)
        c.request("POST", path, body=payload, headers={"Content-Type": "application/json"})
        resp = c.getresponse()
        data = json.loads(resp.read())
        c.close()
        if not data.get("ok") and resp.status >= 400:
            raise BridgeError(f"POST {path} failed: {data.get('error', data)}")
        return data

    # ── Health / info ─────────────────────────────────────────────────────

    def health(self) -> dict:
        """Returns bridge status, version, available models, workspace path."""
        return self._get("/health")

    def workspace_info(self) -> dict:
        """Returns open workspace folders and the active file path."""
        return self._get("/workspace-info")

    def log(self) -> list[str]:
        """Returns the last 100 bridge request log entries."""
        return self._get("/log").get("entries", [])

    # ── LLM / Copilot ────────────────────────────────────────────────────

    def prompt(
        self,
        prompt: str,
        model: str = "",
        system: str = "",
        timeout: int = DEFAULT_TIMEOUT,
        context_files: list[str] | None = None,
    ) -> str:
        """
        Send a prompt to Copilot and return the plain-text response.

        Args:
            prompt:        The question or instruction.
            model:         Copilot model name (e.g. 'Claude Sonnet 4.6'). Auto if empty.
            system:        System prompt override.
            timeout:       Seconds to wait for the LLM response.
            context_files: Absolute paths to files whose contents will be injected.

        Returns:
            The LLM's text response as a string.
        """
        body: dict[str, Any] = {"prompt": prompt, "timeout": timeout}
        if model:         body["model"] = model
        if system:        body["system"] = system
        if context_files: body["context_files"] = context_files
        result = self._post("/prompt", body, timeout=timeout + 10)
        return result.get("text", "")

    def copilot_task(
        self,
        prompt: str,
        auto_accept: bool = True,
        watch_secs: int = 60,
        timeout: int = DEFAULT_TIMEOUT,
        context_files: list[str] | None = None,
        model: str = "",
    ) -> dict:
        """
        Full Copilot task pipeline:
        1. Prompts Copilot with auto-dismiss running in the background
        2. Waits for file changes
        3. Auto-accepts edits and saves all files
        4. Returns diff summary

        Returns dict with keys: llm_response, files_changed, diff_summary, elapsed_ms
        """
        body: dict[str, Any] = {
            "prompt":       prompt,
            "auto_accept":  auto_accept,
            "watch_secs":   watch_secs,
            "timeout":      timeout,
        }
        if context_files: body["context_files"] = context_files
        if model:         body["model"] = model
        return self._post("/copilot-task", body, timeout=timeout + watch_secs + 30)

    # ── Filesystem ───────────────────────────────────────────────────────

    def read_file(self, path: str) -> str:
        """Read a file from disk and return its contents as a string."""
        return self._get(f"/read-file?path={path}").get("content", "")

    def write_file(self, path: str, content: str, create_dirs: bool = True) -> int:
        """Write content to a file. Returns bytes written."""
        return self._post("/write-file", {"path": path, "content": content, "create_dirs": create_dirs}).get("bytes", 0)

    def apply_edit(self, path: str, old_text: str, new_text: str) -> bool:
        """Replace old_text with new_text in a file (exact string match)."""
        return self._post("/apply-edit", {"path": path, "old_text": old_text, "new_text": new_text}).get("ok", False)

    def list_dir(self, path: str = "") -> list[str]:
        """List files/folders at path (defaults to workspace root)."""
        return self._get(f"/list-dir?path={path}").get("entries", [])

    # ── Terminal ─────────────────────────────────────────────────────────

    def run_terminal(self, command: str, cwd: str = "", capture_output: bool = False, timeout: int = 120) -> dict:
        """
        Run a shell command.

        If capture_output=True: runs silently and returns {stdout, stderr, exit_code}.
        If capture_output=False: opens a visible VS Code terminal (no output returned).
        """
        body: dict[str, Any] = {"command": command, "capture_output": capture_output}
        if cwd: body["cwd"] = cwd
        if capture_output: body["timeout"] = timeout
        return self._post("/run-terminal", body, timeout=timeout + 15)

    def run_and_capture(self, command: str, cwd: str = "", timeout: int = 120) -> str:
        """Convenience: run command silently and return stdout as string."""
        result = self.run_terminal(command, cwd=cwd, capture_output=True, timeout=timeout)
        return result.get("stdout", "").strip()

    # ── Editor ───────────────────────────────────────────────────────────

    def open_file(self, path: str, line: int = 0) -> bool:
        """Open a file in the VS Code editor, optionally at a line number."""
        body: dict[str, Any] = {"path": path}
        if line: body["line"] = line
        return self._post("/open-file", body).get("ok", False)

    def diagnostics(self, path: str = "") -> dict:
        """Get errors and warnings for a file (or all open files if path is empty)."""
        qs = f"?path={path}" if path else ""
        return self._get(f"/diagnostics{qs}")

    def exec_command(self, command: str, *args) -> Any:
        """Execute a VS Code command by ID (e.g. 'workbench.action.reloadWindow')."""
        return self._post("/exec-command", {"command": command, "args": list(args)}).get("result")

    def show_message(self, message: str, level: str = "info") -> bool:
        """Show a notification in VS Code. level: 'info' | 'warn' | 'error'"""
        return self._post("/show-message", {"message": message, "level": level}).get("ok", False)

    # ── Dialog auto-dismiss ───────────────────────────────────────────────

    def keep_going(self) -> list[str]:
        """Click all Allow/Continue/Keep/Accept dialogs once. Returns commands run."""
        return self._post("/keep-going", {}).get("commands_run", [])

    def auto_dismiss(self, active: bool = True, interval_ms: int = 1500) -> bool:
        """
        Start (active=True) or stop (active=False) the background dialog-poking loop.
        When active, clicks Allow/Continue/Keep every interval_ms milliseconds.
        """
        return self._post("/auto-dismiss", {"active": active, "interval_ms": interval_ms}).get("active", active)

    def auto_dismiss_status(self) -> bool:
        """Returns True if the auto-dismiss loop is currently running."""
        return self._get("/auto-dismiss").get("active", False)

    # ── Change tracking ───────────────────────────────────────────────────

    def watch_start(self, label: str = "") -> str:
        """Start a file-change watch session. Returns a watch_id."""
        return self._post("/watch-start", {"label": label}).get("watch_id", "")

    def watch_result(self, watch_id: str) -> list[str]:
        """Get files changed since a watch_start call."""
        return self._get(f"/watch-result?id={watch_id}").get("files", [])

    def changes_since(self, timestamp_ms: int) -> list[str]:
        """Get files changed since a Unix timestamp in milliseconds."""
        return self._get(f"/changes-since?ts={timestamp_ms}").get("files", [])

    def pending_approvals(self) -> list[str]:
        """Returns list of unsaved/dirty documents awaiting approval."""
        return self._get("/pending-approvals").get("files", [])

    def accept_edits(self) -> bool:
        return self._post("/accept-edits", {}).get("ok", False)

    def reject_edits(self) -> bool:
        return self._post("/reject-edits", {}).get("ok", False)

    # ── Integrations ──────────────────────────────────────────────────────

    def slack_post(self, text: str, channel: str = "") -> bool:
        """
        Post a message to Slack.
        Token must be configured via VS Code setting agentBridge.slackBotToken
        or in ~/Documents/AgentBridgeConfig/settings.json.
        """
        body: dict[str, Any] = {"text": text}
        if channel: body["channel"] = channel
        return self._post("/slack-post", body).get("ok", False)

    def desktop_type(self, app: str, text: str, window_title: str = "", delay_ms: int = 2000) -> bool:
        """
        Open an app and type text into it using WScript.Shell (Windows only).
        Example: bridge.desktop_type('notepad.exe', 'Hello world!')
        """
        body: dict[str, Any] = {"app": app, "text": text, "delay_ms": delay_ms}
        if window_title: body["window_title"] = window_title
        return self._post("/desktop-type", body).get("ok", False)

    # ── High-level helpers ────────────────────────────────────────────────

    def ask_then_run(self, task_description: str, run_result: bool = True, slack_report: bool = False) -> dict:
        """
        Convenience pipeline:
        1. copilot_task(task_description)  — Copilot writes + saves code
        2. Optionally runs the first changed Python/JS file
        3. Optionally posts result to Slack

        Returns the copilot_task result dict.
        """
        result = self.copilot_task(task_description, auto_accept=True)
        output = ""

        if run_result and result.get("files_changed"):
            for f in result["files_changed"]:
                if f.endswith(".py"):
                    output = self.run_and_capture(f"python \"{f}\"")
                    break
                elif f.endswith(".js"):
                    output = self.run_and_capture(f"node \"{f}\"")
                    break

        if slack_report:
            changed = result.get("files_changed", [])
            msg = f"Task complete.\nChanged: {', '.join(changed) or 'none'}"
            if output:
                msg += f"\nOutput:\n```\n{output[:500]}\n```"
            self.slack_post(msg)

        result["run_output"] = output
        return result


# ── Exception ─────────────────────────────────────────────────────────────────

class BridgeError(Exception):
    pass


# ── CLI smoke test ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys

    print("Connecting to VS Code Agent Bridge...")
    try:
        bridge = AgentBridge()
        h = bridge.health()
        print(f"Connected! Port={h['port']}  Version={h['version']}")
        print(f"Models available: {len(h.get('models', []))}")
        print(f"Workspace: {h.get('workspace', 'N/A')}")

        if "--prompt" in sys.argv:
            idx = sys.argv.index("--prompt")
            q = " ".join(sys.argv[idx + 1:]) if idx + 1 < len(sys.argv) else "Say hello in one sentence."
            print(f"\nPrompting Copilot: {q!r}")
            answer = bridge.prompt(q)
            print(f"Response: {answer}")

    except BridgeError as e:
        print(f"ERROR: {e}")
        print("Make sure VS Code is running with the Agent Bridge extension installed.")
        sys.exit(1)
