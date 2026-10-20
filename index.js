/**
 * dsh-desktop-notify — DSH のイベントを Windows のデスクトップ通知（トースト）にする
 * ホスト専用プラグイン。外部依存なし。Node 標準モジュールと Windows PowerShell だけで動く。
 *
 * 監視する `session/event`:
 *   - tool/call        … ask_user_question / exit_plan_mode（＝ユーザーの回答待ち）
 *   - approval/asked   … ツール実行・サンドボックス昇格の承認待ち
 *   - turn/end         … ターン完了 / エラー / 中断 / ブロック / トークン上限
 *   - session/title    … 通知本文に出すセッション名
 *   - assistant/message… 完了通知に添える応答プレビュー
 *
 * @module dsh-desktop-notify
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ICON_PATH = path.join(HERE, 'icon.png')

/** Toast のアプリ identity。HKCU に一度だけ登録する。 */
const APP_ID = 'DeepSeekHarness.DesktopNotify'
const APP_NAME = 'DeepSeek Harness'

const POWERSHELL = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)

const DEFAULTS = {
  /** 全体スイッチ。false で一切通知しない。 */
  enabled: true,
  /** セッション名が取れないときの見出し。 */
  title: APP_NAME,
  /** メッセージの言語。'ja' | 'en' */
  language: 'ja',
  /** トリガ別スイッチ。 */
  onQuestion: true,
  onApproval: true,
  onTurnEnd: true,
  onError: true,
  onAborted: true,
  onBlocked: true,
  /** ユーザーへの問い合わせとして扱うツール名。 */
  questionTools: ['ask_user_question', 'exit_plan_mode'],
  /** サブエージェントのセッションを通知から除外する。 */
  rootsOnly: true,
  /** ターン完了通知に直前の応答プレビューを添える。 */
  preview: true,
  /** 本文の最大文字数。 */
  bodyChars: 180,
  /** 通知音を鳴らす。 */
  sound: true,
  /** 通知を長め（約25秒）表示する。false で既定（約5秒）。 */
  longDuration: true,
  /** 同一内容の連続通知を抑える最小間隔（ミリ秒）。 */
  minIntervalMs: 500,
  /** 通知の記録先（JSON Lines）。null で記録しない。 */
  logFile: null,
}

const MESSAGES = {
  ja: {
    question: '❓ 質問があります',
    questionMany: (n) => `（他 ${n} 件）`,
    approval: '🔐 承認待ちです',
    completed: '✅ 応答が完了しました',
    error: '⚠️ エラーで終了しました',
    aborted: '⏹ 中断しました',
    blocked: '⏸ ブロックされました',
    maxTokens: '⚠️ トークン上限に達しました',
    unknown: 'ℹ️ ターンが終了しました',
  },
  en: {
    question: '❓ A question is waiting',
    questionMany: (n) => ` (+${n} more)`,
    approval: '🔐 Waiting for approval',
    completed: '✅ Turn completed',
    error: '⚠️ Turn ended with an error',
    aborted: '⏹ Turn aborted',
    blocked: '⏸ Turn blocked',
    maxTokens: '⚠️ Token limit reached',
    unknown: 'ℹ️ Turn ended',
  },
}

/** XML の特殊文字を実体参照にする。 */
function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/** 1 行に収める。 */
function clamp(value, max) {
  const text = String(value ?? '').replaceAll(/\s+/gu, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Toast の XML を組み立てる。 */
function buildToastXml({ heading, body, sound, longDuration }) {
  const audio = sound
    ? '<audio src="ms-winsoundevent:Notification.Default"/>'
    : '<audio silent="true"/>'
  const lines = [`<text>${escapeXml(heading)}</text>`]
  if (body) lines.push(`<text>${escapeXml(body)}</text>`)
  return `<toast duration="${longDuration ? 'long' : 'short'}">`
    + `<visual><binding template="ToastGeneric">${lines.join('')}</binding></visual>`
    + `${audio}</toast>`
}

/**
 * Windows PowerShell でトーストを 1 件表示するスクリプト。
 * 日本語を安全に渡すため XML は base64、スクリプト自体は -EncodedCommand で渡す。
 */
function toastScript(xml) {
  const payload = Buffer.from(xml, 'utf8').toString('base64')
  return [
    "$ErrorActionPreference = 'Stop'",
    '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]',
    '[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime]',
    `$xml = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))`,
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$doc.LoadXml($xml)',
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show($toast)`,
  ].join('\n')
}

/**
 * 子プロセスを起動してトーストを出す。
 *
 * `detached: true` は使わない。実測（Windows 11 / 2026-10）で、detached で起動した
 * PowerShell は終了コード 0 を返すのに、WinRT の `Show()` が通知プラットフォームに
 * 一切登録されない（バナーも通知センターも空のまま）。`windowsHide` だけなら届く。
 * 呼び出し側は子の終了を待たないので、DSH の処理を止めることもない。
 *
 * @param {string} command 実行ファイル
 * @param {string[]} args 引数
 * @param {(code: number|null, error: Error|null) => void} [onExit] 終了通知
 */
function spawnHidden(command, args, onExit) {
  try {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    child.on('error', (error) => onExit?.(null, error))
    child.on('exit', (code) => onExit?.(code, null))
    child.unref()
  } catch (error) {
    onExit?.(null, error)
  }
}

/** AUMID を登録して、トーストにアプリ名とアイコンを出す。 */
function registerAppId() {
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_ID}`
  spawnHidden('reg.exe', ['add', key, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', APP_NAME, '/f'])
  if (existsSync(ICON_PATH)) {
    spawnHidden('reg.exe', ['add', key, '/v', 'IconUri', '/t', 'REG_SZ', '/d', ICON_PATH, '/f'])
  }
}

/** Markdown の装飾を落として、通知本文として読める 1 行にする。 */
function cleanMarkdown(text) {
  return String(text)
    .replaceAll(/```[\s\S]*?```/gu, ' ')
    .replaceAll(/`([^`]*)`/gu, '$1')
    .replaceAll(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replaceAll(/^\s{0,3}#{1,6}\s+/gmu, '')
    .replaceAll(/^\s{0,3}[-*+]\s+/gmu, '')
    .replaceAll(/^\s{0,3}>\s?/gmu, '')
    .replaceAll(/^\s*\|.*\|\s*$/gmu, ' ')
    .replaceAll(/\*\*([^*]+)\*\*/gu, '$1')
    .replaceAll(/__([^_]+)__/gu, '$1')
    .replaceAll(/(^|[\s(])[*_]([^*_\s][^*_]*)[*_]/gu, '$1$2')
    .replaceAll('|', ' ')
}

/** message.content からテキストブロックだけを取り出す。 */
function textOf(message) {
  try {
    const blocks = message?.content
    if (!Array.isArray(blocks)) return ''
    return blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => cleanMarkdown(block.text))
      .join(' ')
  } catch {
    return ''
  }
}

/** JSON 文字列を安全に読む。 */
function parseJson(value) {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Partial<typeof DEFAULTS>} [config]
 */
export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const messages = MESSAGES[cfg.language] ?? MESSAGES.ja
  const isWindows = process.platform === 'win32'

  /** sessionId -> セッション名 */
  const titles = new Map()
  /** sessionId -> 直前のアシスタント応答テキスト */
  const previews = new Map()
  /** 直近に通知した内容と時刻（重複抑止） */
  let lastKey = ''
  let lastAt = 0

  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`[desktop-notify] ${message}`)
    } catch {
      /* ignore */
    }
  }

  const record = (entry) => {
    if (!cfg.logFile) return
    try {
      mkdirSync(path.dirname(cfg.logFile), { recursive: true })
      appendFileSync(cfg.logFile, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`)
    } catch {
      /* ignore */
    }
  }

  const notify = (kind, heading, body) => {
    if (!cfg.enabled) return
    const key = `${heading}\u0000${body}`
    const now = Date.now()
    if (key === lastKey && now - lastAt < 5000) return
    if (now - lastAt < cfg.minIntervalMs) return
    lastKey = key
    lastAt = now

    if (!isWindows) {
      log('warn', `desktop notifications need Windows; skipped (${kind})`)
      record({ kind, heading, body, shown: false, reason: 'platform' })
      return
    }
    spawnHidden(POWERSHELL, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(toastScript(buildToastXml({
        heading,
        body,
        sound: cfg.sound,
        longDuration: cfg.longDuration,
      })), 'utf16le').toString('base64'),
    ], (code, error) => {
      if (error !== null) {
        log('warn', `toast could not start: ${error.message}`)
        record({ kind, heading, body, shown: false, reason: `spawn: ${error.message}` })
        return
      }
      if (code !== 0) {
        log('warn', `toast process exited with ${code}`)
        record({ kind, heading, body, shown: false, reason: `exit ${code}` })
        return
      }
      record({ kind, heading, body, shown: true })
    })
  }

  /** セッション名。取りこぼしても直近のログから拾う。 */
  const titleOf = (session) => {
    const id = session?.id
    if (id === undefined) return ''
    const cached = titles.get(id)
    if (cached !== undefined) return cached
    let found = ''
    try {
      const events = session.snapshotEvents?.() ?? []
      for (let i = events.length - 1; i >= 0; i -= 1) {
        if (events[i].type === 'session/title') {
          found = events[i].data?.title ?? ''
          break
        }
      }
    } catch {
      /* ignore */
    }
    titles.set(id, found)
    return found
  }

  const body = (session, detail) => {
    const parts = [titleOf(session), detail].filter(Boolean)
    return clamp(parts.join(' — '), cfg.bodyChars)
  }

  const onQuestion = (session, data) => {
    const parsed = parseJson(data.arguments)
    const questions = Array.isArray(parsed?.questions) ? parsed.questions : []
    const first = questions[0]
    const text = clamp(first?.question ?? '', cfg.bodyChars)
    if (!text) {
      notify('question', messages.question, clamp(titleOf(session), cfg.bodyChars))
      return
    }
    const extra = questions.length > 1 ? messages.questionMany(questions.length - 1) : ''
    notify('question', messages.question, body(session, `${text}${extra}`))
  }

  const onApproval = (session, data) => {
    const detail = [data.toolName, data.reason ? clamp(data.reason, 80) : '']
      .filter(Boolean)
      .join(': ')
    notify('approval', messages.approval, body(session, detail))
  }

  const onTurnEnd = (session, data) => {
    const reason = data?.reason ?? {}
    const preview = cfg.preview ? previews.get(session.id) ?? '' : ''
    previews.delete(session.id)
    switch (reason.kind) {
      case 'completed':
        if (cfg.onTurnEnd) notify('completed', messages.completed, body(session, preview))
        return
      case 'error':
        if (cfg.onError) {
          const detail = clamp(reason.error?.message ?? preview, cfg.bodyChars)
          notify('error', messages.error, body(session, detail))
        }
        return
      case 'aborted':
      case 'interrupted':
        if (cfg.onAborted) notify('aborted', messages.aborted, body(session, preview))
        return
      case 'blocked':
        if (cfg.onBlocked) notify('blocked', messages.blocked, body(session, preview))
        return
      case 'max-tokens':
        if (cfg.onBlocked) notify('max-tokens', messages.maxTokens, body(session, preview))
        return
      default:
        return
    }
  }

  const handle = (session, event) => {
    if (!cfg.enabled) return
    if (cfg.rootsOnly && session?.header?.origin === 'subagent') return
    const data = event?.data ?? {}
    switch (event?.type) {
      case 'session/title':
        if (session?.id !== undefined) titles.set(session.id, data.title ?? '')
        return
      case 'assistant/message':
        if (cfg.preview && session?.id !== undefined) {
          const text = textOf(data.message)
          if (text) previews.set(session.id, text)
        }
        return
      case 'tool/call':
        if (cfg.onQuestion && cfg.questionTools.includes(data.name)) onQuestion(session, data)
        return
      case 'approval/asked':
        if (cfg.onApproval) onApproval(session, data)
        return
      case 'turn/end':
        onTurnEnd(session, data)
        return
      default:
        return
    }
  }

  registerAppId()
  const effective = {
    enabled: cfg.enabled,
    language: cfg.language,
    onQuestion: cfg.onQuestion,
    onApproval: cfg.onApproval,
    onTurnEnd: cfg.onTurnEnd,
    onError: cfg.onError,
    onAborted: cfg.onAborted,
    onBlocked: cfg.onBlocked,
    rootsOnly: cfg.rootsOnly,
    sound: cfg.sound,
    longDuration: cfg.longDuration,
  }
  log('info', `windows toast notifications ready ${JSON.stringify(effective)}`)
  record({ kind: 'startup', platform: process.platform, pid: process.pid, shown: false, config: effective })

  ctx.on('session/event', (session, event) => {
    try {
      handle(session, event)
    } catch (error) {
      log('warn', `notification failed: ${error?.message ?? error}`)
      record({ kind: 'failure', error: String(error?.message ?? error), shown: false })
    }
  }, { global: true })
}
