// Outbound custom RPCs the host can call on this plugin once the trigger is
// running. Each method maps thinly onto the corresponding Bot API call via
// grammy's `bot.api.*` helpers; we keep the params close to Bot API wire shape
// so workflow YAML / agents can pass through documented Telegram options
// (parse_mode, reply_markup, etc.) without us re-typing every field.
//
// Method names mirror what the plugin advertises in `plugin.toml::methods`
// (e.g. `telegram/send_message`). The dispatcher in `index.ts` strips the
// `telegram/` prefix before calling these handlers.

import type { Bot } from "grammy";

export type OutboundParams = Record<string, unknown>;

function requireString(params: OutboundParams, key: string): string {
  const v = params[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new RpcInvalidParams(`missing or empty required string field '${key}'`);
  }
  return v;
}

function requireChatId(params: OutboundParams): number | string {
  const v = params.chat_id;
  if (typeof v === "number" || (typeof v === "string" && v.length > 0)) return v;
  throw new RpcInvalidParams("missing required field 'chat_id' (number or @channel string)");
}

function requireMessageId(params: OutboundParams): number {
  const v = params.message_id;
  if (typeof v === "number" && Number.isInteger(v)) return v;
  throw new RpcInvalidParams("missing required integer field 'message_id'");
}

function optionalRest(params: OutboundParams, drop: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (!drop.includes(k) && v !== undefined) out[k] = v;
  }
  return out;
}

/** Custom error subclass — the dispatcher maps this to JSON-RPC InvalidParams. */
export class RpcInvalidParams extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcInvalidParams";
  }
}

export type OutboundHandler = (params: OutboundParams) => Promise<unknown>;

export function buildOutboundHandlers(bot: Bot): Record<string, OutboundHandler> {
  return {
    // telegram/send_message — chat_id + text required; passes parse_mode,
    // reply_markup, reply_to_message_id, etc. through to Bot API verbatim.
    async send_message(params) {
      const chatId = requireChatId(params);
      const text = requireString(params, "text");
      const extra = optionalRest(params, ["chat_id", "text"]);
      const result = await bot.api.sendMessage(chatId, text, extra as never);
      return { ok: true, message: result };
    },

    // telegram/send_photo — photo can be a URL, file_id, or InputFile object.
    async send_photo(params) {
      const chatId = requireChatId(params);
      const photo = params.photo;
      if (photo === undefined || photo === null) {
        throw new RpcInvalidParams("missing required field 'photo' (url, file_id, or InputFile)");
      }
      const extra = optionalRest(params, ["chat_id", "photo"]);
      const result = await bot.api.sendPhoto(chatId, photo as never, extra as never);
      return { ok: true, message: result };
    },

    // telegram/edit_message_text — edits a previously sent bot message. Requires
    // chat_id + message_id + text (Bot API also accepts inline_message_id;
    // callers can pass that path through extras).
    async edit_message_text(params) {
      const chatId = requireChatId(params);
      const messageId = requireMessageId(params);
      const text = requireString(params, "text");
      const extra = optionalRest(params, ["chat_id", "message_id", "text"]);
      const result = await bot.api.editMessageText(chatId, messageId, text, extra as never);
      return { ok: true, result };
    },

    // telegram/answer_callback_query — required after a callback_query event,
    // otherwise the user sees a spinner on the inline button forever.
    async answer_callback_query(params) {
      const id = requireString(params, "callback_query_id");
      const extra = optionalRest(params, ["callback_query_id"]);
      const result = await bot.api.answerCallbackQuery(id, extra as never);
      return { ok: true, result };
    },

    // telegram/set_chat_action — emits a typing/upload indicator. Telegram
    // shows the indicator for ~5s; callers re-invoke for longer operations.
    async set_chat_action(params) {
      const chatId = requireChatId(params);
      const action = requireString(params, "action");
      const extra = optionalRest(params, ["chat_id", "action"]);
      const result = await bot.api.sendChatAction(chatId, action as never, extra as never);
      return { ok: true, result };
    },
  };
}
