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

### 3. 設定播報頻道

頻道清單存在 repo 外（`~/.config/twitch-relay/channels-<config 名>.json`），用 CLI 管理。
`add` 會即時驗證頻道存在（打錯字當場擋下）：

```bash
node src/cli.js channels add  <你的帳號>  --config configs/worldcup2026.json
node src/cli.js channels add  <別人的頻道> --config configs/worldcup2026.json
node src/cli.js channels list             --config configs/worldcup2026.json
node src/cli.js channels remove <頻道>     --config configs/worldcup2026.json
```

### 4. 執行

```bash
# 先 dry-run：訊息只印到 console，不發任何聊天訊息（可用 --channel 臨時指定頻道）
node src/cli.js run --config configs/worldcup2026.json --dry-run

# 確認沒問題後正式播報（會 fan-out 到所有已設定頻道）
node src/cli.js run --config configs/worldcup2026.json
```

`run` 至少要有一個頻道（來自 store 或 `--channel <login>`，可重複），否則直接報錯——
不會隱式發到你自己的台。一則事件會同時送到所有頻道，**某頻道失敗不影響其他頻道**。

## Config

```jsonc
{
  "source": {
    "type": "espn",
    "league": "fifa.world",
    "pollIntervalSec": 30, // 沒有比賽進行中時的 poll 間隔
    "livePollIntervalSec": 10 // 有比賽進行中時加速，壓低官方比分的取樣延遲
  },
  "format": {
    "type": "soccer-zh",
    // 可選：goal, card, kickoff, halftime, secondhalf, fulltime
    "events": ["goal", "card", "kickoff", "halftime", "secondhalf", "fulltime"]
  },
  "sink": { "type": "twitch-chat" } // 頻道不寫在 config，用 channels 指令管理
}
```

**進球以「官方比分變化」觸發**（不是事件 key）：顯示的比分就是 ESPN 官方比分、絕對準確，
比分單調遞增天生免疫重播；得分者名字從事件清單盡力標註，撈不到就只報比分。
紅黃牌用穩定事件 key 觸發。比分被 VAR 取消（減少）時會補報「進球取消」。

state（比賽狀態與比分、已播報的牌）與頻道清單都存 `~/.config/twitch-relay/`（per-config，不進 repo）。
重啟不會重複播報；dry-run 也會寫 state，轉正式跑時不洗版。

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
- **多 pipeline 共用同一帳號**（例如世足 + 英超兩個 config 同時跑）時，token refresh
  以 process 內 single-flight + 跨 process retry-with-re-read 處理競爭，無需上鎖、無新失敗模式
