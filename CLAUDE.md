# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev

```bash
npm run build    # TypeScript compilation (tsc)
npm run dev      # Watch mode (tsc --watch)
```

No test framework is configured. `test-inline.mjs` is a manual integration test that hits a live webhook endpoint.

## Architecture

This is an **OpenClaw plugin** — a single-file TypeScript plugin (`src/index.ts`) that registers tools with the OpenClaw agent runtime.

**Plugin entry point**: The default export is a function receiving an `api` object. It uses `api.registerTool()` to register three tools (`process_watch`, `process_unwatch`, `process_watches`) and `api.onShutdown()` for cleanup. Config comes from `api.pluginConfig` (plugin-specific) and `api.config` (global OpenClaw config).

**Core flow**: `startWatch()` spawns a child process, monitors stdout/stderr line-by-line against regex patterns, and calls `triggerAgent()` on matches. `triggerAgent()` implements a throttle (default 5s) so rapid matches don't flood the agent. Webhooks are sent via `sendWebhook()` to the OpenClaw gateway's `/hooks/agent` endpoint.

**State**: All watched processes live in an in-memory `Map<string, WatchedProcess>`. Each entry tracks the child process, a rolling output buffer, throttle state, and the session key for webhook routing.

**Plugin manifest**: `openclaw.plugin.json` defines the plugin ID, description, and config schema (webhookUrl, webhookToken, defaultPatterns).

**Schema validation**: Tool parameter schemas use `@sinclair/typebox` (`Type.Object`, `Type.String`, etc.).
