# dsh-notification

DeepSeek Harness (DSH) のデスクトップ通知プラグイン。**他の作業をしていても気づけるように、Windows のトースト**で「質問された」「承認待ち」「エラーで止まった」を知らせる。

> Desktop toast notifications for DeepSeek Harness on Windows: waiting questions, approvals, turn completion and errors.
> Host-side plugin (no client bundle, no browser permission prompt).

- リポジトリ名は `dsh-notification`、**パッケージ名は `dsh-desktop-notify`**（npm に同名の既存パッケージがあるため分けている）。
- 動作確認: DSH `0.2.1-rc.2` / Windows 11 / デスクトップアプリ（`--profile desktop`）

## できること

| きっかけ | 出す通知 |
| --- | --- |
| モデルが質問（`ask_user_question` / `exit_plan_mode`） | ❓ 質問があります — セッション名と質問文 |
| ツール実行・サンドボックス昇格の承認待ち（`approval/asked`） | 🔐 承認待ちです — ツール名と理由 |
| ターン完了（`turn/end` の `completed`） | ✅ 応答が完了しました — セッション名と応答プレビュー |
| エラー / 中断 / ブロック / トークン上限 | ⚠️ ⏹ ⏸ — 理由とエラー内容 |

実際に出るもの（通知センターの例）:

```
❓ 質問があります
   デスクトップ通知要望 — 通知センターを開いて、いまの一覧を確認してほしい。

✅ 応答が完了しました
   Markdown 整形の確認 — 旋回（戻し） +3.4° → −87.5° まで回した。詳細は wpndatabase.db を参照。
```

**ホスト側で動くのが特徴。** ブラウザの Notification API ではないので、通知の許可ダイアログが不要で、
ウィンドウを最小化していても、別のセッションを開いていても、タスクトレイに隠れていても届く。
サブエージェントのセッションは既定で除外する。

## インストール

```powershell
# GitHub から直接
dsh plugin --profile desktop add github:drydeuterium/dsh-notification

# ローカルのチェックアウトから
git clone https://github.com/drydeuterium/dsh-notification
dsh plugin --profile desktop add .\dsh-notification
```

`dsh plugin` はプロファイルディレクトリで pnpm を回し、`dsh.bundle.patch` を宣言した
パッケージを `dsh.profile.bundles` に自動で足す。手で `package.json` を編集する必要はない。

### 反映（再起動は必須ではない）

- **アプリ起動時**に読まれる。
- 稼働中なら、同じパッケージをもう一度入れ直すと再構成が走って反映される:

  ```powershell
  dsh plugin --profile desktop remove dsh-desktop-notify
  dsh plugin --profile desktop add github:drydeuterium/dsh-notification
  ```

  リンク先パッケージの変更ファイルは次の再構成で差し替わるので、**アプリの再起動は不要**
  （ホストの PID が変わらないことを確認済み）。反映されないときはアプリを再起動する。

### 反映されたかの確認

`logFile` を設定していれば、起動時に実効設定が 1 行記録される:

```json
{"ts":"...","kind":"startup","pid":7376,"shown":false,"config":{"enabled":true,"language":"ja",
 "onQuestion":true,"onApproval":true,"onTurnEnd":true,"onError":true,"onAborted":true,
 "onBlocked":true,"rootsOnly":true,"sound":true,"longDuration":true}}
```

`kind: "startup"` が新しい時刻で出ていれば、そのホストでプラグインが動いている。

## 設定

`cordis.patch.yml` の行 `desktop-notify` の `config` で変える。プロファイル側で上書きするときは、
`~/.dsh/profiles/<profile>/cordis.patch.yml` に**同じ id** の行を足す
（一致した行は `config` 全体を置き換えるので、必要なキーは全部書き直す）。

| キー | 既定 | 意味 |
| --- | --- | --- |
| `enabled` | `true` | 全体スイッチ |
| `language` | `ja` | `ja` / `en` |
| `onQuestion` / `onApproval` / `onTurnEnd` / `onError` / `onAborted` / `onBlocked` | `true` | トリガ別スイッチ |
| `questionTools` | `['ask_user_question', 'exit_plan_mode']` | 回答待ちとして扱うツール名 |
| `rootsOnly` | `true` | サブエージェントを除外 |
| `preview` / `bodyChars` | `true` / `180` | 応答プレビューと本文の最大文字数 |
| `sound` / `longDuration` | `true` / `true` | 通知音 / 約 25 秒表示 |
| `minIntervalMs` | `500` | 同一内容の連続通知を抑える間隔 |
| `logFile` | `null` | 通知の記録先（JSON Lines）。デバッグ用 |

例: 完了通知だけ止めて、質問と承認待ちに絞る

```yaml
- id: desktop-notify
  name: dsh-desktop-notify
  config:
    onTurnEnd: false
```

`config` 全体が置き換わる点に注意。上の例では他のキーがすべて既定値に戻る。

## 動作確認（再現手順）

順番に切り分けられるようにしてある。

### 1. OS までの経路を、DSH を介さず確かめる

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\toast-check.ps1
python tools/wpn-history.py
```

トーストが出て、`wpn-history.py` に `DeepSeekHarness.DesktopNotify` のハンドラと
その通知が並べば、OS 側の経路は正常。

### 2. プラグイン経由で確かめる

DSH に質問させると ❓ が出る。出ない場合は 3 へ。

```powershell
# 通知の記録（logFile を設定している場合）
Get-Content "$env:USERPROFILE\.dsh\logs\desktop-notify.jsonl" -Tail 5
```

`"kind":"question"  "shown":true` が残っていれば、プラグインは動いている。

### 3. OS に登録されたかを DB で確かめる

「PowerShell は成功しているのに見えない」を切り分ける一番確実な方法。
Windows は通知を `%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db`
（SQLite）に記録する。

```powershell
python tools/wpn-history.py --limit 30
python tools/wpn-history.py --search "本文の一部"   # 一覧から消えていても WAL に残っていれば FOUND
```

`--search` は見つからなければ終了コード 1。トーストの投入に成功していても
登録されていないなら、[`docs/detached-spawn.md`](docs/detached-spawn.md) の症状を疑う。

### 4. それでも出ないとき

| 症状 | 見るところ |
| --- | --- |
| 何も出ない / 一覧にも無い | `wpn-history.py` の先頭に出る `SHQueryUserNotificationState` が `5 (ACCEPTS_NOTIFICATIONS)` か。`6 (QUIET_TIME)` なら集中モード |
| 通知センターにはあるがバナーが出ない | 集中モード、通知の設定、フルスクリーン |
| アプリ名やアイコンが付かない | `HKCU\Software\Classes\AppUserModelId\DeepSeekHarness.DesktopNotify` の `DisplayName` / `IconUri` |
| 二重に鳴る | 下の「既知の落とし穴」 |

## 仕組み

`session/event` を 1 本購読するだけ。セッションログは書き換えず、モデルに見えるツールも
プロンプトも増やさない。

| イベント | 用途 |
| --- | --- |
| `tool/call` | `name` が `ask_user_question` / `exit_plan_mode` のとき ❓ |
| `approval/asked` | 承認待ち。ツール名と理由を本文に |
| `turn/end` | `reason.kind` で 完了 / エラー / 中断 / ブロック / トークン上限 を出し分け |
| `session/title` | 本文に出すセッション名 |
| `assistant/message` | 完了通知に添える応答プレビュー（Markdown の装飾は落とす） |

購読は `ctx.on('session/event', handler, { global: true })`。`session.header.origin === 'subagent'`
のセッションは `rootsOnly` で除外する。

通知は `child_process.spawn` で Windows PowerShell を起動し、WinRT の
`ToastNotificationManager` で `ToastGeneric` テンプレートを表示する。**依存パッケージはゼロ**。
日本語は XML を base64、スクリプトを `-EncodedCommand`（UTF-16LE）で渡すので文字化けしない。

**子プロセスは `detached: true` で起動しない。** detached だと `Show()` が成功したように見えて
通知が OS に一切登録されない（実測。[`docs/detached-spawn.md`](docs/detached-spawn.md)）。

トーストのアプリ identity は `DeepSeekHarness.DesktopNotify`。初回に
`HKCU\Software\Classes\AppUserModelId\...` へ `DisplayName` と `IconUri` を登録するので、
通知には「DeepSeek Harness」とアイコンが付く。

## 既知の落とし穴

- **`detached: true`** — 上記のとおり届かない。`tools/detached-repro.mjs --verify` で再現できる。
- **他の通知プラグインとの二重通知** — たとえば `dsh-pet` は「会話完了 / 生成失敗 / 権限申請 / ユーザー選択」を
  ウィンドウ非フォーカス時に通知する。完了が二重になるなら、こちらを `onTurnEnd: false` にするか、
  相手側の通知を切る。ホスト側のプラグインを複数入れている場合も同様。
- **通知のクリックでセッションを開くことはできない** — トーストは表示のみ。クリックでジャンプしたいなら
  クライアント側（ブラウザ Notification API）で出す実装が必要。
- **本文は 2 行まで** — 長いプレビューは通知センターで切られる。`bodyChars` で調整する。

## 制約

- Windows 専用（`process.platform !== 'win32'` では警告ログを出して何もしない）。
- 通知センターの履歴・表示方法は OS の管理。集中モードや通知オフの設定には従う。
- 通知音は `ms-winsoundevent:Notification.Default` 固定。

## アンインストール

```powershell
dsh plugin --profile desktop remove dsh-desktop-notify
```

登録したアプリ identity も消す場合:

```powershell
reg delete HKCU\Software\Classes\AppUserModelId\DeepSeekHarness.DesktopNotify /f
```

## リポジトリ構成

```
index.js             プラグイン本体（apply(ctx, config) / 依存ゼロ）
cordis.patch.yml     バンドル層。行 desktop-notify を挿入する
package.json         dsh.bundle.patch と表示メタデータ
locale/{ja,en}.json  プラグイン一覧に出す title / description
icon.png             トーストとプラグイン一覧のアイコン
docs/detached-spawn.md   detached で届かない件の実測メモ
tools/toast-check.ps1    DSH を介さずトーストを 1 件出す
tools/wpn-history.py     OS の通知 DB を読む（登録されたかの判定）
tools/detached-repro.mjs detached の再現実験
```

## ライセンス

MIT
