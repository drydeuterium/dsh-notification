# `detached: true` で起動したトーストは OS に届かない

Windows 11 / DSH 0.2.1-rc.2 での実測メモ。プラグインから
`child_process.spawn('powershell.exe', ...)` でトーストを出すとき、
**`detached: true` を付けると `Show()` が成功したように見えて（終了コード 0）、
通知が通知センターにもバナーにも一切出ない。**

## 症状

- プラグインのログには「通知した」と残る（`spawn` は成功している）
- 子プロセスの `exit` コードは 0（`$ErrorActionPreference='Stop'` なので例外なら非 0 になる）
- しかし Windows の通知一覧（Win+A）にも、通知データベースにも何も残らない
- `detached` を外すだけで、同じスクリプトが普通に出る

## 切り分け結果

同じトースト用スクリプトを、子プロセスの作り方だけ変えて実行し、
`wpndatabase.db` を読んで「通知プラットフォームに登録されたか」を判定した。

| 変種 | `detached` | 親は子の終了を待つ | 登録 |
| --- | --- | --- | --- |
| `unref-exit` | あり | 待たない | ❌ |
| `wait-detached` | あり | 待つ | ❌ |
| `unref-sleep`（3 秒生存） | あり | 待たない | ❌ |
| `wait-pipe` | なし | 待つ（`stdio: 'pipe'`） | ✅ |
| 同期 `execFileSync` | なし | 待つ | ✅ |

→ **違いは `detached` の有無だけ**。親の生存時間も、`stdio` の種類も、
終了コードも関係ない（`detached` ありは全部 ❌、なしは全部 ✅）。

## 再現

```powershell
# Windows PowerShell 5.1 が要る（WinRT の型は PowerShell 7 では読めない）
node tools/detached-repro.mjs --verify
```

期待される出力:

```
[A] 生バイト検索 'REPRO-...-detached': not found
     => not found（OS に届いていない）
[B] 生バイト検索 'REPRO-...-plain': FOUND
     => FOUND（OS に登録された）
```

## なぜそうなるのか

未確定。`detached: true` は `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` で
起動する（＝コンソールを継承しない）。`windowsHide: true` の `CREATE_NO_WINDOW`
だけなら届くので、コンソールの有無そのものが原因ではなさそう。
WinRT のトースト API が呼び出しプロセスのシェル/デスクトップとの関連付けを
必要とする場面があり、そこで静かに落ちている可能性がある。

推測で直すより、**実測で届く形（`detached` なし）を採用する**のが安全。

## 対策

```js
// これは届かない
spawn(PS, args, { detached: true, stdio: 'ignore', windowsHide: true })

// これなら届く
spawn(PS, args, { stdio: 'ignore', windowsHide: true })
```

親は子の終了を待たない（`child.unref()`）ので、DSH の処理は止まらない。
子は数百ミリ秒で終わる。

> 注意: `exit` コード 0 は「トーストの投入に成功した」ことしか保証しない。
> 実際に表示されたかは `tools/wpn-history.py` で確認する。
