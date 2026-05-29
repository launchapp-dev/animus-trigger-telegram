// Unit tests for the Telegram trigger plugin. We deliberately avoid spinning
// up a real grammy Bot or HTTP listener — those paths are exercised by
// integration tests in the Animus runtime test suite. The tests here cover:
//
//   * config parsing (env validation)
//   * Update → TriggerEvent translation (command parsing, callbacks, scope)
//   * manifest shape (methods + env list)
//   * JSON-RPC dispatch lifecycle (initialize, health/check, MethodNotFound)

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { Update } from "grammy/types";

import { ConfigError, loadConfig } from "./config.js";
import { parseCommand, updateToEvents } from "./inbound.js";
import { buildPluginManifest, dispatch, type RuntimeState } from "./index.js";
import { createWire, PROTOCOL_VERSION } from "@launchapp-dev/animus-plugin-sdk";

function blankState(): RuntimeState {
  return {
    bot: null,
    outbound: null,
    triggerId: null,
    wire: createWire({
      // dummy streams; we never call run() here.
      input: process.stdin,
      output: process.stdout,
    }),
    startedAt: Date.now(),
    lastError: null,
  };
}

describe("config", () => {
  it("rejects missing TELEGRAM_BOT_TOKEN", () => {
    expect(() => loadConfig({})).toThrowError(ConfigError);
  });

  it("defaults to polling mode when TELEGRAM_MODE is unset", () => {
    const cfg = loadConfig({ TELEGRAM_BOT_TOKEN: "fake" });
    expect(cfg.mode).toBe("polling");
    expect(cfg.webhookUrl).toBeNull();
    expect(cfg.webhookPort).toBe(8090);
  });

  it("requires TELEGRAM_WEBHOOK_URL when TELEGRAM_MODE=webhook", () => {
    expect(() =>
      loadConfig({ TELEGRAM_BOT_TOKEN: "fake", TELEGRAM_MODE: "webhook" }),
    ).toThrowError(/TELEGRAM_WEBHOOK_URL/);
  });

  it("parses webhook config end to end", () => {
    const cfg = loadConfig({
      TELEGRAM_BOT_TOKEN: "fake",
      TELEGRAM_MODE: "webhook",
      TELEGRAM_WEBHOOK_URL: "https://example.com/tg",
      TELEGRAM_WEBHOOK_PORT: "9090",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "shh",
      TELEGRAM_ALLOWED_UPDATES: "message, callback_query",
    });
    expect(cfg).toMatchObject({
      mode: "webhook",
      webhookUrl: "https://example.com/tg",
      webhookPort: 9090,
      webhookSecretToken: "shh",
      allowedUpdates: ["message", "callback_query"],
    });
  });

  it("rejects bogus port values", () => {
    expect(() =>
      loadConfig({ TELEGRAM_BOT_TOKEN: "fake", TELEGRAM_WEBHOOK_PORT: "not-a-port" }),
    ).toThrowError(/TELEGRAM_WEBHOOK_PORT/);
  });
});

describe("parseCommand", () => {
  it("recognizes a bare slash command", () => {
    expect(parseCommand("/start")).toEqual({ command: "start", args: "" });
  });

  it("captures args", () => {
    expect(parseCommand("/echo hello there")).toEqual({
      command: "echo",
      args: "hello there",
    });
  });

  it("strips @bot_username suffixes (group chat form)", () => {
    expect(parseCommand("/ping@my_bot args here")).toEqual({
      command: "ping",
      args: "args here",
    });
  });

  it("returns null for non-command text", () => {
    expect(parseCommand("hello there")).toBeNull();
  });
});

describe("updateToEvents", () => {
  const baseChat = { id: 42, type: "private" as const, first_name: "Alice" };
  const baseFrom = { id: 99, is_bot: false, first_name: "Alice" };

  it("emits telegram.command for slash messages", () => {
    const update: Update = {
      update_id: 1,
      message: {
        message_id: 7,
        date: 1700000000,
        chat: baseChat,
        from: baseFrom,
        text: "/start hello",
      },
    };
    const events = updateToEvents("tg-trigger", update);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.kind).toBe("telegram.command");
    expect(events[0]?.payload).toMatchObject({
      command: "start",
      args: "hello",
      chat_scope: "private",
    });
    expect(events[0]?.event_id).toBe("tg:1:command");
    expect(events[0]?.trigger_id).toBe("tg-trigger");
  });

  it("emits telegram.message for plain text", () => {
    const update: Update = {
      update_id: 2,
      message: {
        message_id: 8,
        date: 1700000001,
        chat: { id: 42, type: "supergroup", title: "team" },
        from: baseFrom,
        text: "no slash here",
      },
    };
    const events = updateToEvents("tg-trigger", update);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.kind).toBe("telegram.message");
    expect(events[0]?.payload).toMatchObject({
      text: "no slash here",
      chat_scope: "supergroup",
    });
  });

  it("emits telegram.callback_query for button presses", () => {
    const update: Update = {
      update_id: 3,
      callback_query: {
        id: "cb-1",
        from: baseFrom,
        chat_instance: "ci-1",
        data: "approve:42",
        message: {
          message_id: 9,
          date: 1700000002,
          chat: baseChat,
        },
      },
    };
    const events = updateToEvents("tg-trigger", update);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.kind).toBe("telegram.callback_query");
    expect(events[0]?.payload).toMatchObject({
      callback_query_id: "cb-1",
      data: "approve:42",
      chat_id: 42,
      message_id: 9,
    });
  });
});

describe("plugin manifest", () => {
  it("advertises trigger + outbound + health methods", () => {
    const m = buildPluginManifest();
    expect(m.plugin_kind).toBe("trigger_backend");
    expect(m.name).toBe("animus-trigger-telegram");
    const methods = m.capabilities ?? [];
    expect(methods).toEqual(
      expect.arrayContaining([
        "trigger/watch",
        "trigger/ack",
        "telegram/send_message",
        "telegram/send_photo",
        "telegram/edit_message_text",
        "telegram/answer_callback_query",
        "telegram/set_chat_action",
        "health/check",
      ]),
    );
  });

  it("declares TELEGRAM_BOT_TOKEN as a required env var", () => {
    const m = buildPluginManifest();
    const tokenEntry = (m.env_required ?? []).find(
      (e) => (e as { name?: string }).name === "TELEGRAM_BOT_TOKEN",
    );
    expect(tokenEntry).toBeTruthy();
    expect((tokenEntry as { required?: boolean }).required).toBe(true);
  });
});

describe("dispatch", () => {
  let state: RuntimeState;
  beforeEach(() => {
    state = blankState();
  });
  afterEach(() => {
    state.bot = null;
  });

  it("answers initialize with PluginInfo", async () => {
    const res = await dispatch(state, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocol_version: PROTOCOL_VERSION,
        host_info: { name: "test", version: "0" },
        host_capabilities: {},
      },
    });
    expect(res).toBeDefined();
    expect((res as { id: number }).id).toBe(1);
    expect((res as { result?: unknown }).result).toBeTruthy();
  });

  it("reports health when no bot is running", async () => {
    const res = await dispatch(state, {
      jsonrpc: "2.0",
      id: 2,
      method: "health/check",
    });
    expect(res).toBeDefined();
    expect((res as { result?: { status?: string } }).result?.status).toBe("healthy");
  });

  it("returns MethodNotFound for unknown methods", async () => {
    const res = await dispatch(state, {
      jsonrpc: "2.0",
      id: 3,
      method: "wat/unknown",
    });
    expect(res).toBeDefined();
    expect((res as { error?: { code?: number } }).error?.code).toBeDefined();
  });

  it("rejects outbound calls before trigger/watch", async () => {
    const res = await dispatch(state, {
      jsonrpc: "2.0",
      id: 4,
      method: "telegram/send_message",
      params: { chat_id: 1, text: "hi" },
    });
    expect((res as { error?: { code?: number } }).error?.code).toBeDefined();
  });

  it("treats `exit` notification (no id) as a notification (no response)", async () => {
    // We can't let the test actually call process.exit, so we spy.
    const originalExit = process.exit;
    let called = false;
    (process as unknown as { exit: (code?: number) => void }).exit = ((
      code?: number,
    ) => {
      called = true;
      // swallow — don't actually exit the test runner.
      void code;
    }) as never;
    try {
      const res = await dispatch(state, {
        jsonrpc: "2.0",
        method: "exit",
      });
      expect(res).toBeUndefined();
      // setImmediate fires after this turn; await one tick.
      await new Promise((r) => setImmediate(r));
      expect(called).toBe(true);
    } finally {
      (process as unknown as { exit: typeof originalExit }).exit = originalExit;
    }
  });
});
