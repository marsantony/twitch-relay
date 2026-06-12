// per-config 的本機檔案路徑（~/.config/twitch-relay/<kind>-<config 名>.json）。
// state 與 channels 都用這個規則：不同 pipeline 的資料按 config 名分開、互不干擾。
// basename 會剝掉目錄成分，使用者給惡意 config 路徑也無法逃出 ~/.config/twitch-relay/。
import { join, basename } from "node:path";
import { homedir } from "node:os";

export function configScopedPath(kind, configPath) {
  const name = basename(configPath).replace(/\.json$/, "");
  return join(homedir(), ".config", "twitch-relay", `${kind}-${name}.json`);
}
