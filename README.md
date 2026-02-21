# openclaw-procwatch

OpenClaw plugin that watches process output and triggers agent invocations when patterns match.

Perfect for dev servers, build tools, and test runners — the agent gets automatically notified when errors, warnings, or custom patterns appear in output.

## Install

```bash
openclaw plugins install @jturle/openclaw-procwatch
```

Or from source:

```bash
git clone https://github.com/jturle/openclaw-procwatch.git
cd openclaw-procwatch
npm install
npm run build
openclaw plugins install .
```

## Setup

The plugin uses OpenClaw webhooks to trigger agent invocations. Make sure webhooks are enabled:

```json5
// openclaw.json
{
  hooks: {
    enabled: true,
    token: "${OPENCLAW_HOOKS_TOKEN}"
  }
}
```

Set the token in your environment:

```bash
export OPENCLAW_HOOKS_TOKEN="your-secret-token"
```

## Usage

Once installed, the agent has three new tools:

### `process_watch`

Start watching a process:

```
Start my dev server: npm run dev
```

The agent will use `process_watch` with default patterns (errors, warnings, failures). You can also specify custom patterns:

```
Watch `npm test` for test failures and "PASS" messages
```

### `process_unwatch`

Stop watching a process:

```
Stop watching the dev server
```

### `process_watches`

List active watches:

```
What processes are you watching?
```

## How It Works

1. Agent starts a process with `process_watch`
2. Plugin monitors stdout/stderr in real-time
3. When output matches a pattern (e.g., "Error", "TypeError", "failed")
4. Plugin triggers the agent via webhook with context
5. Agent wakes up and can respond/fix the issue

## Default Patterns

Out of the box, the plugin watches for:

- `error|Error|ERROR` → "Error"
- `TypeError|ReferenceError|SyntaxError` → "JS Error"
- `ENOENT|EACCES|EADDRINUSE` → "System Error"
- `failed|Failed|FAILED` → "Failure"
- `warning|Warning|WARN` → "Warning"
- `Build failed|Compilation failed` → "Build Failed"

Process exits also trigger the agent with the last 15 lines of output.

## Configuration

Optional plugin config in `openclaw.json`:

```json5
{
  plugins: {
    procwatch: {
      webhookUrl: "http://127.0.0.1:18789",  // default
      webhookToken: "your-token",  // or use OPENCLAW_HOOKS_TOKEN env
      defaultPatterns: [
        { regex: "error", label: "Error", contextLines: 15 },
        { regex: "ready on", label: "Server Ready", contextLines: 5 }
      ]
    }
  }
}
```

## Example Session

```
You: Start watching npm run dev

Agent: Started watching process 'dev':
- Command: npm run dev
- Patterns: Error, JS Error, System Error, Failure, Warning, Build Failed
- PID: 12345

I'll be invoked automatically when patterns match.

[... time passes, you edit code and introduce a bug ...]

Agent: **JS Error** detected in process `dev`:

[stderr] TypeError: Cannot read property 'map' of undefined
[stderr]     at UserList (/app/components/UserList.tsx:42:18)
[stderr]     at renderWithHooks (/app/node_modules/react-dom/...

Process: `npm run dev`

Looks like `users` is undefined in UserList.tsx line 42. Let me check...
```

## License

MIT
