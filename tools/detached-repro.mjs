// 「detached で起動した PowerShell は exit 0 なのにトーストが OS に届かない」を再現する。
//
// 同じトースト用スクリプトを 2 通りで起動する:
//   A: detached: true  + stdio:'ignore' + windowsHide  ← プラグインの旧実装（届かない）
//   B: detached なし   + stdio:'ignore' + windowsHide  ← 現行実装（届く）
//
// 使い方:
//   node tools/detached-repro.mjs           # 2 件撃って、確認コマンドを表示
//   node tools/detached-repro.mjs --verify  # python があれば DB まで自動確認
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ID = 'DeepSeekHarness.DesktopNotify'
const PS = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wpn-history.py')

const token = `REPRO-${new Date().toISOString().replaceAll(/[-:T.Z]/gu, '').slice(0, 14)}`

function toastScript(body) {
  const xml = '<toast duration="long"><visual><binding template="ToastGeneric">'
    + '<text>🔬 detached 再現テスト</text>'
    + `<text>${body}</text>`
    + '</binding></visual><audio src="ms-winsoundevent:Notification.Default"/></toast>'
  return [
    "$ErrorActionPreference = 'Stop'",
    '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]',
    '[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime]',
    `$xml = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(xml, 'utf8').toString('base64')}'))`,
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$doc.LoadXml($xml)',
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show($toast)`,
  ].join('\n')
}

function fire({ detached, body, label }) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(toastScript(body), 'utf16le').toString('base64')]
  const options = { stdio: 'ignore', windowsHide: true }
  if (detached) options.detached = true
  const child = spawn(PS, args, options)
  child.on('exit', (code) => console.log(`[${label}] exit=${code}`))
  child.unref()
}

const bodyA = `${token}-detached`
const bodyB = `${token}-plain`

console.log(`token: ${token}\n`)
console.log('A: detached: true（旧実装）を起動')
fire({ detached: true, body: bodyA, label: 'A' })
await new Promise((resolve) => setTimeout(resolve, 4000))
console.log('B: detached なし（現行実装）を起動')
fire({ detached: false, body: bodyB, label: 'B' })
await new Promise((resolve) => setTimeout(resolve, 4000))

const python = spawnSync('python', ['--version'], { encoding: 'utf8' })
const hasPython = python.status === 0

const verify = process.argv.includes('--verify') && hasPython
for (const [label, body] of [['A', bodyA], ['B', bodyB]]) {
  const args = [TOOL, '--search', body]
  if (verify) {
    const run = spawnSync('python', args, { encoding: 'utf8' })
    const tail = (run.stdout ?? '').trim().split('\n').slice(-2).join(' ')
    console.log(`\n[${label}] ${tail}`)
    console.log(`     => ${run.status === 0 ? 'FOUND（OS に登録された）' : 'not found（OS に届いていない）'}`)
  } else {
    console.log(`\n確認: python "${TOOL}" --search "${body}"`)
  }
}
if (!verify) {
  console.log('\n期待: A は not found、B は FOUND。')
  console.log('--verify を付けると python で自動判定する（python が PATH にある場合）。')
}
