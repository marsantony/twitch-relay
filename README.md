# twitch-relay

可重用的「input → Twitch 聊天室」播報框架。把任意資料來源的事件 diff 出來、
格式化成中文訊息，以你自己的 Twitch 身分發到聊天室。

第一個 use case：**FIFA 世界盃 2026 即時播報**——進球、紅黃牌、開賽／中場／完場。

## 架構

```
sources/  ──▶  core/diff  ──▶  format/  ──▶  sinks/
（ESPN…）      （事件偵測）     （中文模板）    （Twitch chat、console）
```

- **sources/**：資料來源 plugin。`fetchSnapshot()` 回傳正規化快照，上游結構變動被隔離在這層。
  目前有 `espn`（支援任何 ESPN 足球聯賽：`fifa.world`、`eng.1`、`usa.1`…）
- **core/diff**：純函式 diff 引擎。首次看到的比賽當基線不播報（寧漏播不洗版）、
  已播報事件 append-only 去重（重啟、資料抖動都不會重播）
- **format/**：事件 → 訊息模板，可設定要播報的事件種類
- **sinks/**：輸出端。`twitch-chat`（Helix API 發話）與 `console`（dry-run）
- 組裝由 `configs/*.json` 宣告，加新聯賽／新來源不動核心

## 使用方式

### 1. 建立 Twitch app（一次性）

到 [dev.twitch.tv/console](https://dev.twitch.tv/console) 建立 app，
**Client Type 選 Public**（Device Code Flow 不需要 client secret）。

### 2. 授權（一次性）

```bash
node src/cli.js auth --client-id <你的 client id>
```

依提示在瀏覽器輸入代碼完成授權。token 存到 `~/.config/twitch-relay/token.json`
（權限 600，不在 repo 內），之後過期會自動 refresh。

### 3. 執行

```bash
# 先 dry-run：訊息只印到 console，不發任何聊天訊息
node src/cli.js run --config configs/worldcup2026.json --dry-run

# 確認沒問題後正式播報
node src/cli.js run --config configs/worldcup2026.json
```

## Config

```jsonc
{
  "source": { "type": "espn", "league": "fifa.world", "pollIntervalSec": 20 },
  "format": {
    "type": "soccer-zh",
    // 可選：goal, card, kickoff, halftime, secondhalf, fulltime
    "events": ["goal", "card", "kickoff", "halftime", "secondhalf", "fulltime"]
  },
  "sink": { "type": "twitch-chat", "channel": "" } // 留空 = 發到自己的頻道
}
```

state（已播報事件、比賽狀態）存 `~/.config/twitch-relay/state-<config 名>.json`，
重啟不會重複播報；dry-run 也會寫入，轉正式跑時不洗版。

## 技術棧

- Node.js 20+，零 runtime 依賴（原生 fetch）
- 測試：vitest（`npm test`），CI 由 GitHub Actions 跑
- Twitch auth：OAuth Device Code Grant Flow（public client）
- 發話：Helix `POST /helix/chat/messages`（scope `user:write:chat`），
  並檢查回應的 `is_sent` / `drop_reason`——HTTP 200 不代表訊息有進聊天室

## 注意事項

- ESPN scoreboard API 為非官方介面，無 SLA，結構可能變動；
  發生時只需修 `src/sources/espn.js`，其他層不受影響
- refresh token 為一次性，token 檔採原子寫入；若看到「請重新執行 auth」，
  跑一次 `auth` 指令即可
