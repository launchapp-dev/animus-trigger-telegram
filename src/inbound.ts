// Translate grammy Update objects into Animus TriggerEvent notifications.
//
// We emit three kinds:
//   * telegram.command      — message text that starts with `/` (slash command).
//   * telegram.message      — any other text/media message.
//   * telegram.callback_query — inline keyboard button presses.
//
// Wire shape matches `crates/animus-trigger-protocol::TriggerEvent`. The host
// uses `trigger_id` (from the workflow YAML `[[triggers]]` block) to route
// each event, and `event_id` to ack. We keep payloads close to the raw
// Telegram Update so downstream agents can read `message.from.username`,
// `callback_query.data`, etc. without us re-shaping fields.

import type { Update, Message, CallbackQuery } from "grammy/types";

export type TelegramEventKind =
  | "telegram.command"
  | "telegram.message"
  | "telegram.callback_query";

/** Wire shape matches `animus_plugin_protocol::TriggerEvent` (flat fields).
 *  We embed our internal event kind inside `payload.kind` so downstream
 *  workflow matchers can switch on `${trigger.payload.kind}` — the host's
 *  TriggerEvent struct deliberately has no top-level `kind` field. */
export interface TelegramTriggerEvent {
  trigger_id: string;
  event_id: string;
  payload: Record<string, unknown> & { kind: TelegramEventKind };
}

/** Stable event_id derived from Telegram's update_id (unique per bot, monotonic). */
function eventIdFor(update: Update, suffix: string): string {
  return `tg:${update.update_id}:${suffix}`;
}

function chatScope(msg: Message): "private" | "group" | "supergroup" | "channel" | "unknown" {
  const t = msg.chat.type;
  if (t === "private" || t === "group" || t === "supergroup" || t === "channel") return t;
  return "unknown";
}

/** Extract the command name from a `/cmd@bot args` message — returns `null` if
 *  the message doesn't look like a bot command. */
export function parseCommand(text: string): { command: string; args: string } | null {
  if (!text.startsWith("/")) return null;
  // Strip a leading `/`, then split on first whitespace.
  const stripped = text.slice(1);
  const wsIdx = stripped.search(/\s/);
  const rawHead = wsIdx === -1 ? stripped : stripped.slice(0, wsIdx);
  const args = wsIdx === -1 ? "" : stripped.slice(wsIdx + 1).trim();
  // Drop the `@bot_username` suffix Telegram appends in group chats.
  const atIdx = rawHead.indexOf("@");
  const command = atIdx === -1 ? rawHead : rawHead.slice(0, atIdx);
  if (command.length === 0) return null;
  return { command, args };
}

/** Translate a single grammy Update into zero or more TriggerEvents. */
export function updateToEvents(
  triggerId: string,
  update: Update,
): TelegramTriggerEvent[] {
  const out: TelegramTriggerEvent[] = [];

  const msgText = update.message?.text;
  if (update.message && typeof msgText === "string") {
    const msg = update.message;
    const text: string = msgText;
    const cmd = parseCommand(text);
    if (cmd) {
      out.push({
        trigger_id: triggerId,
        event_id: eventIdFor(update, "command"),
        payload: {
          kind: "telegram.command",
          command: cmd.command,
          args: cmd.args,
          text,
          chat_id: msg.chat.id,
          chat_scope: chatScope(msg),
          from: msg.from ?? null,
          message_id: msg.message_id,
          date: msg.date,
          raw_update: update,
        },
      });
      return out;
    }
  }

  if (update.message) {
    const msg = update.message;
    out.push({
      trigger_id: triggerId,
      event_id: eventIdFor(update, "message"),
      payload: {
        kind: "telegram.message",
        text: typeof msg.text === "string" ? msg.text : null,
        chat_id: msg.chat.id,
        chat_scope: chatScope(msg),
        from: msg.from ?? null,
        message_id: msg.message_id,
        date: msg.date,
        has_photo: Array.isArray(msg.photo) && msg.photo.length > 0,
        has_document: msg.document !== undefined,
        raw_update: update,
      },
    });
  }

  if (update.callback_query) {
    const cq: CallbackQuery = update.callback_query;
    out.push({
      trigger_id: triggerId,
      event_id: eventIdFor(update, "callback"),
      payload: {
        kind: "telegram.callback_query",
        callback_query_id: cq.id,
        data: cq.data ?? null,
        from: cq.from,
        chat_id: cq.message?.chat.id ?? null,
        message_id: cq.message?.message_id ?? null,
        raw_update: update,
      },
    });
  }

  return out;
}
