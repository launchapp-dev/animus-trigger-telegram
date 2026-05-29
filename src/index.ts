// Animus trigger_backend plugin entrypoint.
//
// Why we build the JSON-RPC loop directly (instead of `definePlugin`):
// `@launchapp-dev/animus-plugin-sdk@v0.1.0` only wires `subject_backend` in
// its built-in dispatcher; `trigger_backend` returns MethodNotFound for every
// domain call. We still use the SDK's manifest helpers, wire codec, and error
// codes so the handshake stays byte-compatible with the Rust runtime; the
// trigger-specific routing (`trigger/watch`, `trigger/ack`,
// `telegram/<verb>`, `health/check`, lifecycle methods) lives here.
//
// When the SDK ships a wired trigger dispatcher we can migrate to
// `definePlugin({ kind: 'trigger_backend', impl: ... })`.

import process from "node:process";
import { stdout as nodeStdout } from "node:process";

import {
  ErrorCode,
  PROTOCOL_VERSION,
  PluginKind,
  buildInitializeResult,
  buildManifest,
  createWire,
  errorResponse,
  okResponse,
  validateInitializeParams,
  type InitializeParams,
  type PluginIdentity,
  type PluginManifest,
  type RpcRequest,
  type RpcResponse,
  type Wire,
} from "@launchapp-dev/animus-plugin-sdk";

import { ConfigError, loadConfig } from "./config.js";
import { startBot, type BotHandle } from "./bot-client.js";
import { updateToEvents } from "./inbound.js";
import {
  RpcInvalidParams,
  buildOutboundHandlers,
  type OutboundHandler,
  type OutboundParams,
} from "./outbound.js";

const NAME = "animus-trigger-telegram";
const VERSION = "0.1.1";
const DESCRIPTION =
  "Telegram Bot API trigger plugin — webhook + long-polling inbound, send/edit/typing outbound.";

const OUTBOUND_METHODS = [
  "telegram/send_message",
  "telegram/send_photo",
  "telegram/edit_message_text",
  "telegram/answer_callback_query",
  "telegram/set_chat_action",
];
const TRIGGER_METHODS = ["trigger/watch", "trigger/schema", "trigger/ack"];
const TRIGGER_SCHEMA = {
  kinds: ["telegram.command", "telegram.message", "telegram.callback_query"],
  supports_resume: false,
  supports_dedup: false,
  supports_ack: true,
};

interface RuntimeState {
  bot: BotHandle | null;
  outbound: Record<string, OutboundHandler> | null;
  triggerId: string | null;
  wire: Wire;
  startedAt: number;
  lastError: string | null;
}

function buildIdentity(): PluginIdentity {
  return {
    name: NAME,
    version: VERSION,
    description: DESCRIPTION,
    plugin_kind: PluginKind.TriggerBackend,
  };
}

function buildPluginManifest(): PluginManifest {
  // Advertise every method we can actually serve so the daemon's preflight +
  // doctor see a coherent picture from manifest discovery alone (no spawn
  // required for `animus plugin info`).
  const capabilities = {
    methods: [...TRIGGER_METHODS, ...OUTBOUND_METHODS, "health/check"],
    streaming: true,
    progress: false,
    cancellation: false,
  };
  return buildManifest(buildIdentity(), capabilities, {
    env_required: [
      {
        name: "TELEGRAM_BOT_TOKEN",
        description: "Bot token issued by @BotFather.",
        required: true,
        sensitive: true,
      },
      {
        name: "TELEGRAM_MODE",
        description: "Inbound mode: 'polling' (default) or 'webhook'.",
        required: false,
      },
      {
        name: "TELEGRAM_WEBHOOK_URL",
        description: "Public HTTPS URL for Telegram POSTs (required when TELEGRAM_MODE=webhook).",
        required: false,
      },
      {
        name: "TELEGRAM_WEBHOOK_PORT",
        description: "Local TCP port for the webhook listener (default 8090).",
        required: false,
      },
      {
        name: "TELEGRAM_WEBHOOK_SECRET_TOKEN",
        description: "Optional secret token for X-Telegram-Bot-Api-Secret-Token validation.",
        required: false,
        sensitive: true,
      },
      {
        name: "TELEGRAM_ALLOWED_UPDATES",
        description: "Comma-separated allowed_updates list (default: all).",
        required: false,
      },
    ],
  });
}

async function handleManifestCliFlag(manifest: PluginManifest): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--manifest") || args.includes("-m")) {
    await new Promise<void>((resolve, reject) => {
      nodeStdout.write(`${JSON.stringify(manifest)}\n`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    process.exit(0);
  }
  if (args.includes("--help") || args.includes("-h")) {
    process.stderr.write(
      `${NAME} ${VERSION} - Animus Telegram trigger plugin\n` +
        "Usage:\n" +
        `  ${NAME} --manifest    Print plugin manifest as JSON and exit\n` +
        `  ${NAME}               Run JSON-RPC loop on stdin/stdout\n`,
    );
    process.exit(0);
  }
}

/** Kick off the bot in the configured mode and wire updates into trigger/event
 *  notifications on the JSON-RPC channel. */
async function startWatch(state: RuntimeState, triggerId: string): Promise<void> {
  if (state.bot) {
    // Single-watcher contract (mirrors webhook trigger plugin). A second
    // watch() against the same plugin process would race two
    // bot.start()/server.listen() loops.
    throw new Error("trigger/watch already invoked; only one watcher per plugin instance");
  }
  const config = loadConfig();
  state.triggerId = triggerId;
  const bot = await startBot(config, async (update) => {
    const events = updateToEvents(triggerId, update);
    for (const evt of events) {
      try {
        // Wire contract: `trigger/event` params deserialize directly into the
        // host's `animus_plugin_protocol::TriggerEvent` struct (flat fields:
        // `event_id`, `trigger_id`, `payload`, optional `subject_id` /
        // `subject_kind` / `action_hint`). No `event` wrapper, no
        // `occurred_at`. Verified against
        // `crates/orchestrator-daemon-runtime/src/schedule/trigger_supervisor.rs`
        // and `crates/animus-plugin-protocol/src/lib.rs::TriggerEvent`.
        await state.wire.notify("trigger/event", evt);
      } catch (err) {
        process.stderr.write(
          `[${NAME}] failed to forward trigger/event: ${String(err)}\n`,
        );
      }
    }
  });
  state.bot = bot;
  state.outbound = buildOutboundHandlers(bot.bot);
}

async function handleAck(_state: RuntimeState, _params: OutboundParams): Promise<void> {
  // Telegram has no server-side ack model for getUpdates / webhooks. We log
  // for observability but otherwise no-op — the host's ack is purely
  // bookkeeping in this plugin.
}

async function handleOutbound(
  state: RuntimeState,
  verb: string,
  params: OutboundParams,
): Promise<unknown> {
  if (!state.outbound) {
    throw new Error(
      `outbound RPC '${verb}' called before trigger/watch — bot not started yet`,
    );
  }
  const handler = state.outbound[verb];
  if (!handler) {
    throw new RpcInvalidParams(`unknown telegram outbound method '${verb}'`);
  }
  return handler(params);
}

async function dispatch(state: RuntimeState, frame: RpcRequest): Promise<RpcResponse | undefined> {
  const id = frame.id;
  const method = frame.method;

  if (id === undefined) {
    // Notifications: never respond. Handle `exit` (graceful shutdown) +
    // `trigger/ack` (which the protocol delivers as a notification).
    if (method === "exit") {
      void shutdown(state).finally(() => setImmediate(() => process.exit(0)));
      return undefined;
    }
    if (method === "trigger/ack") {
      try {
        await handleAck(state, (frame.params ?? {}) as OutboundParams);
      } catch (err) {
        process.stderr.write(`[${NAME}] trigger/ack handler error: ${String(err)}\n`);
      }
      return undefined;
    }
    // Drop unknown notifications silently (matches Rust runtime + SDK base).
    return undefined;
  }

  switch (method) {
    case "initialize": {
      const params = (frame.params ?? {}) as InitializeParams;
      const incompat = validateInitializeParams(params);
      if (incompat) {
        return errorResponse(id, ErrorCode.InvalidRequest, incompat);
      }
      // Reuse the SDK's helper so PROTOCOL_VERSION flows from the SDK constant
      // instead of being hardcoded here (otherwise a future bump would silently
      // desync from the manifest).
      void PROTOCOL_VERSION;
      const capabilities = {
        methods: [...TRIGGER_METHODS, ...OUTBOUND_METHODS, "health/check"],
        streaming: true,
        progress: false,
        cancellation: false,
      };
      return okResponse(id, buildInitializeResult(buildIdentity(), capabilities));
    }
    case "$/ping":
      return okResponse(id, {});
    case "health/check": {
      const healthy = state.lastError === null;
      return okResponse(id, {
        status: healthy ? "healthy" : "degraded",
        uptime_ms: Date.now() - state.startedAt,
        memory_usage_bytes: process.memoryUsage().rss,
        last_error: state.lastError,
      });
    }
    case "shutdown": {
      await shutdown(state);
      return okResponse(id, {});
    }
    case "exit":
      setImmediate(() => process.exit(0));
      return okResponse(id, {});
    case "trigger/watch": {
      try {
        const params = (frame.params ?? {}) as { trigger_id?: string; config?: unknown };
        const triggerId =
          typeof params.trigger_id === "string" && params.trigger_id.length > 0
            ? params.trigger_id
            : "telegram";
        await startWatch(state, triggerId);
        // The watcher itself is open-ended — `trigger/event` notifications
        // flow until shutdown. We acknowledge the watch request synchronously
        // so the host knows the listener is live.
        return okResponse(id, { ok: true, trigger_id: triggerId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        state.lastError = msg;
        const code = err instanceof ConfigError ? ErrorCode.InvalidParams : ErrorCode.InternalError;
        return errorResponse(id, code, `trigger/watch failed: ${msg}`);
      }
    }
    case "trigger/schema":
      return okResponse(id, TRIGGER_SCHEMA);
    case "trigger/ack": {
      // Some hosts deliver ack as a request rather than a notification.
      // Honor both — same payload, just send an empty ok back.
      try {
        await handleAck(state, (frame.params ?? {}) as OutboundParams);
        return okResponse(id, { ok: true });
      } catch (err) {
        return errorResponse(id, ErrorCode.InternalError, `trigger/ack failed: ${String(err)}`);
      }
    }
    default: {
      if (method.startsWith("telegram/")) {
        const verb = method.slice("telegram/".length);
        try {
          const result = await handleOutbound(state, verb, (frame.params ?? {}) as OutboundParams);
          return okResponse(id, result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (err instanceof RpcInvalidParams) {
            return errorResponse(id, ErrorCode.InvalidParams, msg);
          }
          state.lastError = msg;
          return errorResponse(id, ErrorCode.InternalError, msg);
        }
      }
      return errorResponse(id, ErrorCode.MethodNotFound, `unknown method '${method}'`);
    }
  }
}

async function shutdown(state: RuntimeState): Promise<void> {
  if (state.bot) {
    try {
      await state.bot.stop();
    } catch (err) {
      process.stderr.write(`[${NAME}] shutdown error: ${String(err)}\n`);
    }
    state.bot = null;
    state.outbound = null;
  }
}

async function main(): Promise<void> {
  const manifest = buildPluginManifest();
  await handleManifestCliFlag(manifest);
  const wire = createWire();
  const state: RuntimeState = {
    bot: null,
    outbound: null,
    triggerId: null,
    wire,
    startedAt: Date.now(),
    lastError: null,
  };
  // Surface uncaught errors via stderr without crashing the JSON-RPC loop —
  // a single bad Telegram API call shouldn't kill the plugin.
  process.on("unhandledRejection", (err) => {
    process.stderr.write(`[${NAME}] unhandledRejection: ${String(err)}\n`);
  });
  await wire.run((frame) => dispatch(state, frame));
  // Stream closed → daemon disconnected. Best-effort shutdown of the bot.
  await shutdown(state);
}

// Allow this module to be imported (tests) without auto-running. We auto-run
// when the bundle is executed directly — either via `node dist/index.cjs`
// (argv[1] ends with index.cjs) OR via the npm-style `bin` shim
// (`animus-trigger-telegram`), which is how the Animus daemon spawns the
// plugin per `plugin.toml::binary`. Vitest runs us as an imported module, so
// `import.meta.url` won't match `argv[1]` there.
const isDirectRun = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  // Direct `node dist/index.cjs` style.
  if (argv1.endsWith("index.cjs") || argv1.endsWith("index.js") || argv1.endsWith("index.ts")) return true;
  // bin-shim style: the daemon execs `animus-trigger-telegram` (the name
  // declared in package.json#bin). The shim re-execs Node against this same
  // bundle.
  if (argv1.endsWith("animus-trigger-telegram")) return true;
  // Fallback: compare the script path's resolved URL against this module's
  // own URL. Works when the bin is a symlink to dist/index.cjs.
  try {
    const moduleUrl = import.meta.url;
    const argvUrl = new URL(`file://${argv1}`).href;
    if (moduleUrl === argvUrl) return true;
  } catch {
    // import.meta unavailable (CJS shim) — fall through.
  }
  return false;
})();

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`[${NAME}] fatal: ${String(err)}\n`);
    process.exit(1);
  });
}

// Exported for tests.
export {
  buildPluginManifest,
  dispatch,
  type RuntimeState,
};
