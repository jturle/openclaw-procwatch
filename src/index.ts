import { spawn, ChildProcess } from "node:child_process";
import { Type, type Static } from "@sinclair/typebox";

// Types
interface WatchPattern {
  regex: string;
  label: string;
  contextLines?: number;
}

interface WatchedProcess {
  id: string;
  command: string;
  args: string[];
  patterns: WatchPattern[];
  process: ChildProcess;
  buffer: string[];
  maxBufferLines: number;
  startedAt: Date;
}

interface PluginConfig {
  webhookUrl?: string;
  webhookToken?: string;
  defaultPatterns?: WatchPattern[];
}

// State
const processes = new Map<string, WatchedProcess>();
let pluginConfig: PluginConfig = {};
let invokeAgent: ((message: string, name?: string) => Promise<void>) | null = null;

// Webhook invocation
async function triggerAgent(message: string, name: string = "ProcWatch"): Promise<void> {
  if (invokeAgent) {
    await invokeAgent(message, name);
    return;
  }

  // Fallback to direct webhook call
  const url = pluginConfig.webhookUrl || "http://127.0.0.1:18789";
  const token = pluginConfig.webhookToken || process.env.OPENCLAW_HOOKS_TOKEN;

  if (!token) {
    console.error("[procwatch] No webhook token configured");
    return;
  }

  try {
    const res = await fetch(`${url}/hooks/agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        message,
        name,
        wakeMode: "now",
      }),
    });

    if (!res.ok) {
      console.error(`[procwatch] Webhook failed: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.error("[procwatch] Webhook error:", err);
  }
}

// Process management
function startWatch(
  id: string,
  command: string,
  args: string[],
  patterns: WatchPattern[],
  maxBufferLines: number = 100
): WatchedProcess {
  const proc = spawn(command, args, {
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const watched: WatchedProcess = {
    id,
    command,
    args,
    patterns,
    process: proc,
    buffer: [],
    maxBufferLines,
    startedAt: new Date(),
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
          const contextLines = pattern.contextLines ?? 10;
          const context = watched.buffer.slice(-contextLines).join("\n");

          triggerAgent(
            `**${pattern.label}** detected in process \`${id}\`:\n\n\`\`\`\n${context}\n\`\`\`\n\nProcess: \`${command} ${args.join(" ")}\``,
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
    triggerAgent(
      `Process \`${id}\` exited with ${reason}.\n\nLast output:\n\`\`\`\n${watched.buffer.slice(-15).join("\n")}\n\`\`\``,
      "ProcWatch:Exit"
    );
    processes.delete(id);
  });

  proc.on("error", (err) => {
    triggerAgent(
      `Process \`${id}\` failed to start: ${err.message}`,
      "ProcWatch:Error"
    );
    processes.delete(id);
  });

  processes.set(id, watched);
  return watched;
}

function stopWatch(id: string): boolean {
  const watched = processes.get(id);
  if (!watched) return false;

  watched.process.kill("SIGTERM");
  processes.delete(id);
  return true;
}

// Tool schemas
const ProcessWatchParams = Type.Object({
  id: Type.String({ description: "Unique identifier for this watch" }),
  command: Type.String({ description: "Command to run (e.g., 'npm run dev')" }),
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
export default function (api: any) {
  // Get config
  pluginConfig = api.getConfig?.() || {};

  // Register agent invocation helper if available
  if (api.invokeAgent) {
    invokeAgent = api.invokeAgent;
  }

  // Register tools
  api.registerTool({
    name: "process_watch",
    description:
      "Start a process and watch its output. Triggers agent invocation when patterns match (errors, warnings, etc). Useful for dev servers, build watchers, test runners.",
    parameters: ProcessWatchParams,
    async execute(_id: string, params: Static<typeof ProcessWatchParams>) {
      const { id, command, patterns, cwd } = params;

      if (processes.has(id)) {
        return {
          content: [{ type: "text", text: `Watch '${id}' already exists. Stop it first with process_unwatch.` }],
        };
      }

      const effectivePatterns = patterns?.length
        ? patterns
        : pluginConfig.defaultPatterns?.length
          ? pluginConfig.defaultPatterns
          : DEFAULT_PATTERNS;

      // Parse command into parts
      const parts = command.split(" ");
      const cmd = parts[0];
      const args = parts.slice(1);

      // Change to cwd if specified
      const originalCwd = process.cwd();
      if (cwd) {
        try {
          process.chdir(cwd);
        } catch (err) {
          return {
            content: [{ type: "text", text: `Failed to change to directory: ${cwd}` }],
          };
        }
      }

      try {
        const watched = startWatch(id, cmd, args, effectivePatterns);

        return {
          content: [
            {
              type: "text",
              text: `Started watching process '${id}':\n- Command: ${command}\n- Patterns: ${effectivePatterns.map((p) => p.label).join(", ")}\n- PID: ${watched.process.pid}\n\nI'll be invoked automatically when patterns match.`,
            },
          ],
        };
      } finally {
        if (cwd) process.chdir(originalCwd);
      }
    },
  });

  api.registerTool({
    name: "process_unwatch",
    description: "Stop watching a process",
    parameters: ProcessUnwatchParams,
    async execute(_id: string, params: Static<typeof ProcessUnwatchParams>) {
      const { id } = params;

      if (stopWatch(id)) {
        return {
          content: [{ type: "text", text: `Stopped watching process '${id}'` }],
        };
      } else {
        return {
          content: [{ type: "text", text: `No watch found with id '${id}'` }],
        };
      }
    },
  });

  api.registerTool({
    name: "process_watches",
    description: "List all active process watches",
    parameters: ProcessListParams,
    async execute() {
      if (processes.size === 0) {
        return {
          content: [{ type: "text", text: "No active process watches." }],
        };
      }

      const list = Array.from(processes.values())
        .map((p) => {
          const uptime = Math.round((Date.now() - p.startedAt.getTime()) / 1000);
          return `- **${p.id}**: \`${p.command} ${p.args.join(" ")}\` (PID ${p.process.pid}, up ${uptime}s)`;
        })
        .join("\n");

      return {
        content: [{ type: "text", text: `Active watches:\n${list}` }],
      };
    },
  });

  // Cleanup on shutdown
  api.onShutdown?.(() => {
    for (const [id, watched] of processes) {
      console.log(`[procwatch] Stopping ${id}`);
      watched.process.kill("SIGTERM");
    }
    processes.clear();
  });
}
