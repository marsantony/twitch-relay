// dry-run sink：把要播報的訊息印到 console，不對外發任何請求。
export function createConsoleSink({ logger }) {
  return {
    async init() {
      return { dryRun: true };
    },
    async send(message) {
      logger.info(`[dry-run] ${message}`);
      return { status: "sent" };
    },
  };
}
