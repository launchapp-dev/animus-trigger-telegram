// Environment-driven plugin configuration. The plugin host clears the daemon's
// environment before spawn and only forwards the variables declared in
// `plugin.toml::env_required`/optional, so anything we read here must appear
// in that allowlist.

export type TelegramMode = "polling" | "webhook";

export interface TelegramConfig {
  token: string;
  mode: TelegramMode;
  webhookUrl: string | null;
  webhookPort: number;
  webhookSecretToken: string | null;
  allowedUpdates: string[] | null;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TelegramConfig {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    throw new ConfigError(
      "TELEGRAM_BOT_TOKEN is required. Get one from @BotFather on Telegram.",
    );
  }

  const rawMode = (env.TELEGRAM_MODE ?? "polling").trim().toLowerCase();
  if (rawMode !== "polling" && rawMode !== "webhook") {
    throw new ConfigError(
      `TELEGRAM_MODE must be 'polling' or 'webhook' (got '${rawMode}')`,
    );
  }
  const mode = rawMode as TelegramMode;

  const webhookUrl = env.TELEGRAM_WEBHOOK_URL?.trim() || null;
  if (mode === "webhook" && !webhookUrl) {
    throw new ConfigError(
      "TELEGRAM_MODE=webhook requires TELEGRAM_WEBHOOK_URL (public HTTPS URL).",
    );
  }
  if (webhookUrl && !/^https?:\/\//.test(webhookUrl)) {
    throw new ConfigError(
      "TELEGRAM_WEBHOOK_URL must be a full URL starting with http(s)://",
    );
  }

  const portRaw = env.TELEGRAM_WEBHOOK_PORT?.trim();
  let webhookPort = 8090;
  if (portRaw) {
    const parsed = Number.parseInt(portRaw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
      throw new ConfigError(
        `TELEGRAM_WEBHOOK_PORT must be 1-65535 (got '${portRaw}')`,
      );
    }
    webhookPort = parsed;
  }

  const secret = env.TELEGRAM_WEBHOOK_SECRET_TOKEN?.trim() || null;

  let allowedUpdates: string[] | null = null;
  const rawAllowed = env.TELEGRAM_ALLOWED_UPDATES?.trim();
  if (rawAllowed) {
    allowedUpdates = rawAllowed
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (allowedUpdates.length === 0) allowedUpdates = null;
  }

  return {
    token,
    mode,
    webhookUrl,
    webhookPort,
    webhookSecretToken: secret,
    allowedUpdates,
  };
}
