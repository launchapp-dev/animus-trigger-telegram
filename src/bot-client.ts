// Thin wrapper around grammy's `Bot` that exposes two lifecycle entrypoints:
//   * startPolling()  — long-polling via getUpdates loop (dev mode).
//   * startWebhook()  — bind an HTTP listener and call setWebhook so Telegram
//                       POSTs updates to us (production mode).
//
// Both modes feed parsed Updates through `onUpdate` exactly once per update,
// so the inbound translator in `inbound.ts` doesn't care which transport the
// update arrived over.

import { Bot, webhookCallback } from "grammy";
import type { Update } from "grammy/types";
import { createServer, type Server } from "node:http";

import type { TelegramConfig } from "./config.js";

export interface BotHandle {
  bot: Bot;
  /** Stop polling / unbind the HTTP server. Idempotent. */
  stop(): Promise<void>;
  /** Underlying HTTP server in webhook mode (null in polling mode). */
  server: Server | null;
}

export type UpdateHandler = (update: Update) => Promise<void> | void;

/** Create a grammy Bot and start it in the configured mode. The returned
 *  handle owns the lifecycle until `stop()` is called. */
export async function startBot(
  config: TelegramConfig,
  onUpdate: UpdateHandler,
): Promise<BotHandle> {
  const bot = new Bot(config.token);
  // grammy normally builds Update routing via middleware (bot.on/bot.command/etc).
  // We bypass that and capture every update via a catch-all `on("message")` /
  // `on("callback_query")` style handler so all routing happens in
  // `inbound.ts`. The simplest way: `bot.use` a middleware that forwards
  // `ctx.update` to our handler.
  bot.use(async (ctx, next) => {
    try {
      await onUpdate(ctx.update);
    } catch (err) {
      process.stderr.write(
        `[animus-trigger-telegram] update handler error: ${String(err)}\n`,
      );
    }
    await next();
  });

  // Validate the token early — saves a confusing failure mode where the
  // first inbound update yields a 401 from Bot API. grammy's `init()` calls
  // getMe under the hood.
  await bot.init();

  if (config.mode === "polling") {
    // bot.start() is a long-lived promise; intentionally NOT awaited here so
    // startBot() returns once polling is running. Errors during the polling
    // loop are surfaced via the bot's error handler.
    bot.catch((err) => {
      process.stderr.write(
        `[animus-trigger-telegram] grammy error: ${String(err.error)}\n`,
      );
    });
    void bot.start({
      drop_pending_updates: false,
      allowed_updates: (config.allowedUpdates ?? undefined) as never,
      onStart: (botInfo) => {
        process.stderr.write(
          `[animus-trigger-telegram] polling as @${botInfo.username}\n`,
        );
      },
    });
    return {
      bot,
      server: null,
      async stop() {
        await bot.stop();
      },
    };
  }

  // Webhook mode: bind an HTTP listener, then register the webhook with
  // Telegram. The webhookCallback adapter parses POST bodies and forwards
  // them through the middleware chain (which includes our onUpdate hook).
  if (!config.webhookUrl) {
    // Defensive — loadConfig already enforces this. Keep the check here so a
    // misuse of the library form (programmatic call with a bad config) fails
    // loudly instead of crashing inside grammy.
    throw new Error("webhook mode requires webhookUrl");
  }
  const handle = webhookCallback(bot, "http", {
    secretToken: config.webhookSecretToken ?? undefined,
  });
  const server = createServer((req, res) => {
    // grammy's http adapter wants Node req/res. Wrap to swallow errors so a
    // single malformed POST can't crash the listener.
    Promise.resolve(handle(req, res)).catch((err) => {
      process.stderr.write(
        `[animus-trigger-telegram] webhook handler error: ${String(err)}\n`,
      );
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.webhookPort, () => {
      server.off("error", reject);
      resolve();
    });
  });

  try {
    await bot.api.setWebhook(config.webhookUrl, {
      secret_token: config.webhookSecretToken ?? undefined,
      allowed_updates: (config.allowedUpdates ?? undefined) as never,
    });
  } catch (err) {
    // If Telegram rejects the webhook URL (bad cert, unreachable host, rate
    // limit, …) we must release the port — otherwise a `trigger/watch` retry
    // in the same process hits EADDRINUSE on listen() and the plugin can't
    // recover without a daemon restart.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw err;
  }
  process.stderr.write(
    `[animus-trigger-telegram] webhook listening on :${config.webhookPort}, registered ${config.webhookUrl}\n`,
  );

  return {
    bot,
    server,
    async stop() {
      // Best-effort: deleteWebhook so Telegram stops POSTing at a dead URL.
      try {
        await bot.api.deleteWebhook();
      } catch {
        // Swallow — we still want to close the listener even if Telegram is
        // unreachable at shutdown.
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
