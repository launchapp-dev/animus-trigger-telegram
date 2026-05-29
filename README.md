# animus-trigger-telegram

Telegram Bot API trigger plugin for [Animus](https://github.com/launchapp-dev/animus). Receives inbound updates from Telegram (slash commands, regular messages, inline button presses) and exposes outbound RPCs so workflows can reply, edit messages, show typing indicators, and post photos.

Built on [grammy](https://grammy.dev), a modern TypeScript-native Bot API client.

## Why grammy

| Library | Why we picked it / didn't |
|--|--|
| **grammy** (chosen) | Modern, TS-first types for `Update`/`Context`, supports both polling and `webhookCallback` out of the box, smaller dependency footprint, active maintenance. |
| node-telegram-bot-api | Older JS-prototype API, weaker types, no first-class webhook adapter, larger transitive dep tree. |
| telegraf | Excellent but middleware-centric model fights our "raw `Update` → translator" pipeline. |

## Setup

### 1. Get a bot token

1. Open Telegram, message **@BotFather**.
2. Send `/newbot`, follow the prompts.
3. Copy the token (`123456:ABC-DEF…`).

### 2. Choose an inbound mode

| Mode | When to use | Env |
|--|--|--|
| `polling` (default) | Local dev, no public URL needed. Plugin calls `getUpdates` in a loop. | `TELEGRAM_MODE=polling` |
| `webhook` | Production. Plugin binds an HTTP listener and registers a webhook with Telegram. | `TELEGRAM_MODE=webhook` + `TELEGRAM_WEBHOOK_URL=https://your-public-host/tg` |

### 3. Install the plugin

```bash
animus plugin install launchapp-dev/animus-trigger-telegram@v0.1.0
```

### 4. Set required env on the daemon

```bash
export TELEGRAM_BOT_TOKEN="123456:ABC-DEF…"
# Optional:
export TELEGRAM_MODE=polling                            # or 'webhook'
export TELEGRAM_WEBHOOK_URL=https://example.com/tg-hook # required iff webhook
export TELEGRAM_WEBHOOK_PORT=8090                       # default 8090
export TELEGRAM_WEBHOOK_SECRET_TOKEN=optional-shared-secret
export TELEGRAM_ALLOWED_UPDATES=message,callback_query  # default: all kinds
animus daemon restart
```

### 5. Reference it from a workflow

```yaml
# .animus/workflows.yaml (or .animus/workflows/telegram-support.yaml)
triggers:
  - id: tg-support
    backend: animus-trigger-telegram
    config: {}            # plugin reads token + mode from env, not YAML
    workflow_ref: support-reply

workflows:
  - id: support-reply
    on:
      - kind: telegram.command
        match:
          command: "help"
      - kind: telegram.message
    phases:
      - id: respond
        agent: claude
        # Custom RPC on the trigger plugin: reply in the same chat.
        # `chat_id` comes from `${trigger.payload.chat_id}`.
```

## Inbound events

| Event kind | Fires on | Key payload fields |
|--|--|--|
| `telegram.command` | Text message starting with `/` | `command`, `args`, `text`, `chat_id`, `chat_scope`, `from`, `message_id` |
| `telegram.message` | Any other message | `text`, `chat_id`, `chat_scope`, `from`, `has_photo`, `has_document` |
| `telegram.callback_query` | Inline keyboard button press | `callback_query_id`, `data`, `chat_id`, `message_id`, `from` |

`chat_scope` is one of `private` / `group` / `supergroup` / `channel`. The full raw Update is always included under `raw_update` for advanced consumers.

## Outbound RPCs

All take a JSON params object that maps onto the Bot API request body. Optional Bot API fields (`parse_mode`, `reply_markup`, `reply_to_message_id`, `disable_notification`, …) are forwarded verbatim.

| Method | Required params | Description |
|--|--|--|
| `telegram/send_message` | `chat_id`, `text` | Send a text message. |
| `telegram/send_photo` | `chat_id`, `photo` (URL, file_id, or InputFile) | Send a photo. |
| `telegram/edit_message_text` | `chat_id`, `message_id`, `text` | Edit a previous bot message. |
| `telegram/answer_callback_query` | `callback_query_id` | Required after a `telegram.callback_query` event or the button stays in a loading state. |
| `telegram/set_chat_action` | `chat_id`, `action` (e.g. `typing`, `upload_photo`) | Show a typing/upload indicator (~5s, re-invoke for longer ops). |

## Environment variables

| Var | Required | Default | Notes |
|--|--|--|--|
| `TELEGRAM_BOT_TOKEN` | yes | — | From @BotFather. |
| `TELEGRAM_MODE` | no | `polling` | `polling` or `webhook`. |
| `TELEGRAM_WEBHOOK_URL` | iff `webhook` | — | Public HTTPS URL Telegram posts to. |
| `TELEGRAM_WEBHOOK_PORT` | no | `8090` | Local TCP port. |
| `TELEGRAM_WEBHOOK_SECRET_TOKEN` | no | — | Shared secret in `X-Telegram-Bot-Api-Secret-Token`. |
| `TELEGRAM_ALLOWED_UPDATES` | no | all | Comma-separated `allowed_updates` list. |

## Develop

```bash
pnpm install
pnpm run build
pnpm run test
pnpm run typecheck

# Run the plugin manually for stdio testing
node dist/index.js < some-rpc-fixture.jsonl
node dist/index.js --manifest
```

## Not yet covered (v0.2 roadmap)

* Inline mode (`inline_query` / `chosen_inline_result`)
* Telegram Payments (`shipping_query`, `pre_checkout_query`)
* Voice / video / sticker outbound helpers (`send_audio`, `send_video`, etc.)
* Forum topics (`message_thread_id` filter passthrough)
* MTProto user accounts (Bot API only for v0.1.0)
* Per-chat resume cursors on `trigger/watch` (Telegram's getUpdates `offset` is currently held only in-process)

## License

[Elastic-2.0](./LICENSE)
