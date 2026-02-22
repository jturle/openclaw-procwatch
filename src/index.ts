import { spawn, ChildProcess } from "node:child_process";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk";

// Types
interface WatchPattern {
  regex: string;
  label: string;
  contextLines?: number;
}

interface WatchedProcess {
  id: string;
  sessionKey: string;
  command: string;
  patterns: WatchPattern[];
  process: ChildProcess;
  buffer: string[];
  maxBufferLines: number;
  startedAt: Date;
  lastNotifyAt: number; // timestamp for throttling
  pendingNotify: { message: string; name: string } | null;
  throttleTimer: ReturnType<typeof setTimeout> | null;
}

interface PluginConfig {
  defaultPatterns?: WatchPattern[];
  throttleMs?: number; // default 5000
}

// State
const processes = new Map<string, WatchedProcess>();
let pluginConfig: PluginConfig = {};
let enqueueSystemEvent: PluginRuntime["system"]["enqueueSystemEvent"];
let gatewayPort = 18789;
let hooksToken: string | undefined;
let logger: OpenClawPluginApi["logger"] = {
  info: (msg) => console.log(`[procwatch] ${msg}`),
  warn: (msg) => console.warn(`[procwatch] ${msg}`),
  error: (msg) => console.error(`[procwatch] ${msg}`),
};

const THROTTLE_MS = 5000; // 5 second throttle

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: null };
}

// Notify session via system event + wake
function notifySession(message: string, name: string, sessionKey: string): void {
  logger.info(`System event for session '${sessionKey}': ${name} - ${message.slice(0, 80)}...`);

  // Enqueue the event content for the agent to see on next turn
  enqueueSystemEvent(`[ProcWatch:${name}] ${message}`, { sessionKey });

  // TODO: re-enable once hook auth is sorted
  // wakeAgent(name, sessionKey);
}

async function wakeAgent(name: string, sessionKey: string): Promise<void> {
  if (!hooksToken) {
    logger.warn("No hooks token configured - agent will see event on next heartbeat");
    return;
  }

  const url = `http://127.0.0.1:${gatewayPort}/hooks/agent`;
  const payload = {
    message: name,
    name,
    sessionKey,
    channel: "last",
    wakeMode: "now",
    deliver: true,
  };

  const tokenPreview = hooksToken!.slice(0, 6) + "...";
  logger.info(`Hook request to ${url} (token: ${tokenPreview}): ${JSON.stringify(payload)}`);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${hooksToken}`,
      },
      body: JSON.stringify(payload),
    });

    const body = await res.text();
    if (res.ok) {
      logger.info(`Hook success for session '${sessionKey}': ${body}`);
    } else {
      logger.error(`Hook failed: ${res.status} ${res.statusText} - ${body}`);
    }
  } catch (err) {
    logger.error(`Hook error: ${err}`);
  }
}

// Throttled notification
function triggerAgent(watched: WatchedProcess, message: string, name: string): void {
  const now = Date.now();
  const throttleMs = pluginConfig.throttleMs ?? THROTTLE_MS;
  const timeSinceLastNotify = now - watched.lastNotifyAt;

  if (timeSinceLastNotify >= throttleMs) {
    // Can send immediately
    watched.lastNotifyAt = now;
    watched.pendingNotify = null;
    if (watched.throttleTimer) {
      clearTimeout(watched.throttleTimer);
      watched.throttleTimer = null;
    }
    notifySession(message, name, watched.sessionKey);
  } else {
    // Throttle: update pending (latest wins)
    logger.info(`Throttling notification for '${watched.id}' (session: ${watched.sessionKey}) - will send in ${throttleMs - timeSinceLastNotify}ms`);
    watched.pendingNotify = { message, name };

    if (!watched.throttleTimer) {
      watched.throttleTimer = setTimeout(() => {
        if (watched.pendingNotify) {
          watched.lastNotifyAt = Date.now();
          notifySession(watched.pendingNotify.message, watched.pendingNotify.name, watched.sessionKey);
          watched.pendingNotify = null;
        }
        watched.throttleTimer = null;
      }, throttleMs - timeSinceLastNotify);
    }
  }
}

// Process management
function startWatch(
  id: string,
  sessionKey: string,
  command: string,
  patterns: WatchPattern[],
  maxBufferLines: number = 100
): WatchedProcess {
  const proc = spawn(command, [], {
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const watched: WatchedProcess = {
    id,
    sessionKey,
    command,
    patterns,
    process: proc,
    buffer: [],
    maxBufferLines,
    startedAt: new Date(),
    lastNotifyAt: 0,
    pendingNotify: null,
    throttleTimer: null,
  };

  const handleOutput = (data: Buffer, stream: "stdout" | "stderr") => {
    const lines = data.toString().split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;

      // Add to rolling buffer
      watched.buffer.push(`[${stream}] ${line}`);
      if (watched.buffer.length > watched.maxBufferLines) {
        watched.buffer.shift();
      }

      // Check patterns
      for (const pattern of patterns) {
        const re = new RegExp(pattern.regex, "i");
        if (re.test(line)) {
          logger.info(`Pattern match in '${id}' (session: ${sessionKey}): "${pattern.label}" matched: ${line.slice(0, 80)}`);
          const contextLines = pattern.contextLines ?? 10;
          const context = watched.buffer.slice(-contextLines).join("\n");

          triggerAgent(
            watched,
            `**${pattern.label}** detected in process \`${id}\`:\n\n\`\`\`\n${context}\n\`\`\`\n\nProcess: \`${command}\``,
            `ProcWatch:${pattern.label}`
          );
        }
      }
    }
  };

  proc.stdout?.on("data", (data) => handleOutput(data, "stdout"));
  proc.stderr?.on("data", (data) => handleOutput(data, "stderr"));

  proc.on("exit", (code, signal) => {
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    logger.info(`Process '${id}' exited (${reason}) - session: ${sessionKey}`);
    
    // Clear any pending throttle timer
    if (watched.throttleTimer) {
      clearTimeout(watched.throttleTimer);
    }

    triggerAgent(
      watched,
      `Process \`${id}\` exited with ${reason}.\n\nLast output:\n\`\`\`\n${watched.buffer.slice(-15).join("\n")}\n\`\`\``,
      "ProcWatch:Exit"
    );
    processes.delete(id);
  });

  proc.on("error", (err) => {
    logger.error(`Process '${id}' failed to start: ${err.message} - session: ${sessionKey}`);
    triggerAgent(
      watched,
      `Process \`${id}\` failed to start: ${err.message}`,
      "ProcWatch:Error"
    );
    processes.delete(id);
  });

  logger.info(`Process '${id}' started (PID ${proc.pid}) - session: ${sessionKey} - command: ${command}`);
  processes.set(id, watched);
  return watched;
}

function stopWatch(id: string): boolean {
  const watched = processes.get(id);
  if (!watched) return false;

  logger.info(`Stopping process '${id}' (PID ${watched.process.pid}) - session: ${watched.sessionKey}`);
  
  // Clear any pending throttle timer
  if (watched.throttleTimer) {
    clearTimeout(watched.throttleTimer);
  }

  watched.process.kill("SIGTERM");
  processes.delete(id);
  return true;
}

// Tool schemas
const ProcessWatchParams = Type.Object({
  id: Type.String({ description: "Unique identifier for this watch" }),
  command: Type.String({ description: "Command to run (e.g., 'npm run dev')" }),
  sessionKey: Type.String({ description: "Session key to notify when patterns match" }),
  patterns: Type.Optional(
    Type.Array(
      Type.Object({
        regex: Type.String({ description: "Regex pattern to match" }),
        label: Type.String({ description: "Human-readable label for this pattern" }),
        contextLines: Type.Optional(
          Type.Number({ description: "Lines of context to include (default 10)" })
        ),
      })
    )
  ),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
});

const ProcessUnwatchParams = Type.Object({
  id: Type.String({ description: "Watch ID to stop" }),
});

const ProcessListParams = Type.Object({});

// Default patterns for common dev scenarios
const DEFAULT_PATTERNS: WatchPattern[] = [
  { regex: "error|Error|ERROR", label: "Error", contextLines: 15 },
  { regex: "TypeError|ReferenceError|SyntaxError", label: "JS Error", contextLines: 20 },
  { regex: "ENOENT|EACCES|EADDRINUSE", label: "System Error", contextLines: 10 },
  { regex: "failed|Failed|FAILED", label: "Failure", contextLines: 15 },
  { regex: "warning|Warning|WARN", label: "Warning", contextLines: 10 },
  { regex: "Build failed|Compilation failed", label: "Build Failed", contextLines: 20 },
];

// Plugin entry
export default function (api: OpenClawPluginApi) {
  // Use OpenClaw logger if available
  if (api.logger) {
    logger = {
      info: (msg: string) => api.logger.info(`[procwatch] ${msg}`),
      warn: (msg: string) => api.logger.warn(`[procwatch] ${msg}`),
      error: (msg: string) => api.logger.error(`[procwatch] ${msg}`),
    };
  }

  // Get plugin-specific config from api.pluginConfig
  pluginConfig = (api.pluginConfig as PluginConfig) || {};

  // Grab system event dispatcher from runtime
  enqueueSystemEvent = api.runtime.system.enqueueSystemEvent;

  // Resolve hooks token for wake calls (local loopback to gateway)
  const hooksConfig = (api.config as Record<string, any>)?.hooks;
  hooksToken = hooksConfig?.token || process.env.OPENCLAW_HOOKS_TOKEN;
  if (hooksConfig?.port) gatewayPort = hooksConfig.port;

  const throttleMs = pluginConfig.throttleMs ?? THROTTLE_MS;
  logger.info(`Plugin initialized (throttle: ${throttleMs}ms, wake: ${hooksToken ? "enabled" : "disabled"})`);

  // Register tools
  api.registerTool({
    name: "process_watch",
    label: "Process Watch",
    description:
      "Start a process and watch its output. Triggers agent invocation when patterns match (errors, warnings, etc). Useful for dev servers, build watchers, test runners.",
    parameters: ProcessWatchParams,
    async execute(_id: string, params: Static<typeof ProcessWatchParams>) {
      const { id, command, sessionKey, patterns, cwd } = params;

      if (processes.has(id)) {
        return textResult(`Watch '${id}' already exists. Stop it first with process_unwatch.`);
      }

      const effectivePatterns = patterns?.length
        ? patterns
        : pluginConfig.defaultPatterns?.length
          ? pluginConfig.defaultPatterns
          : DEFAULT_PATTERNS;

      // Change to cwd if specified
      const originalCwd = process.cwd();
      if (cwd) {
        try {
          process.chdir(cwd);
        } catch (err) {
          return textResult(`Failed to change to directory: ${cwd}`);
        }
      }

      try {
        const watched = startWatch(id, sessionKey, command, effectivePatterns);

        return textResult(
          `Started watching process '${id}':\n- Command: ${command}\n- Session: ${sessionKey}\n- Patterns: ${effectivePatterns.map((p) => p.label).join(", ")}\n- PID: ${watched.process.pid}\n- Throttle: ${pluginConfig.throttleMs ?? THROTTLE_MS}ms\n\nI'll be invoked automatically when patterns match.`
        );
      } finally {
        if (cwd) process.chdir(originalCwd);
      }
    },
  });

  api.registerTool({
    name: "process_unwatch",
    label: "Process Unwatch",
    description: "Stop watching a process",
    parameters: ProcessUnwatchParams,
    async execute(_id: string, params: Static<typeof ProcessUnwatchParams>) {
      const { id } = params;

      if (stopWatch(id)) {
        return textResult(`Stopped watching process '${id}'`);
      } else {
        return textResult(`No watch found with id '${id}'`);
      }
    },
  });

  api.registerTool({
    name: "process_watches",
    label: "Process Watches",
    description: "List all active process watches",
    parameters: ProcessListParams,
    async execute() {
      if (processes.size === 0) {
        return textResult("No active process watches.");
      }

      const list = Array.from(processes.values())
        .map((p) => {
          const uptime = Math.round((Date.now() - p.startedAt.getTime()) / 1000);
          return `- **${p.id}**: \`${p.command}\` (PID ${p.process.pid}, session: ${p.sessionKey}, up ${uptime}s)`;
        })
        .join("\n");

      return textResult(`Active watches:\n${list}`);
    },
  });

  // Cleanup on shutdown
  api.on("gateway_stop", () => {
    for (const [, watched] of processes) {
      logger.info(`Shutdown: stopping ${watched.id}`);
      if (watched.throttleTimer) {
        clearTimeout(watched.throttleTimer);
      }
      watched.process.kill("SIGTERM");
    }
    processes.clear();
  });
}
