// dry-run sink：把要播報的訊息印到 console，不對外發任何請求、不需 auth。
// 介面對齊 twitch-chat sink：init 回頻道清單、send 回 per-channel results。
export function createConsoleSink({ logger, channels = [] }) {
  const logins = channels.map((c) => c.login);
  return {
    async init() {
      if (logins.length === 0) {
        throw new Error("沒有要播報的頻道，請先 channels add <name> 或用 --channel");
      }
      return { login: "dry-run", senderId: null, channels: logins };
    },
    async send(message) {
      logger.info(`[dry-run → ${logins.join(", ")}] ${message}`);
      return { results: logins.map((channel) => ({ channel, status: "sent" })) };
    },
  };
}
