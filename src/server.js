import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, normalize } from 'node:path'

import { config } from './config.js'
import { verifyInitData } from './initData.js'
import { verifyToken } from './token.js'
import { speechToText, polish, STYLES } from './stt.js'
import * as tg from './telegram.js'
import * as store from './store.js'
import { handleUpdate, bootstrap } from './bot.js'

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'cache-control': 'no-store',
    // Mini App живёт внутри Telegram, поэтому фрейминг Telegram-ом разрешаем,
    // а всё остальное закрываем.
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  })
  res.end(body)
}

const json = (res, status, obj) =>
  send(res, status, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8' })

function tooBig() {
  const err = new Error('слишком большой запрос')
  err.status = 413
  return err
}

async function readBody(req, limit) {
  // Бессерверные площадки часто читают тело за нас и кладут в req.body —
  // поток к этому моменту уже пуст, и чтение вернуло бы ничего.
  if (req.body !== undefined && req.body !== null) {
    const pre = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body), 'utf8')
    if (pre.length > limit) throw tooBig()
    return pre
  }

  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw tooBig()
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * Кто пришёл. Два равноправных способа подтвердить это:
 *   • данные запуска от Telegram — когда окно открыто из чата с ботом;
 *   • наш собственный пропуск — когда окно открыто из панели в чужом чате,
 *     где Telegram данных запуска не передаёт.
 * При провале сразу отвечаем 401.
 */
function auth(req, res, body = {}) {
  // Сначала данные запуска: они богаче — вместе с ними приходит query_id, а с
  // ним можно отправить сообщение прямо в исходный чат. Пропуск такого не даёт,
  // поэтому он именно запасной, даже когда пришли оба.
  const initData = body.initData ?? req.headers['x-init-data']
  let reason = 'ни данных запуска, ни пропуска'
  if (initData) {
    const result = verifyInitData(String(initData), config.botToken)
    if (result.ok) return result
    reason = result.reason
  }

  const token = body.token ?? req.headers['x-app-token']
  if (token) {
    const pass = verifyToken(String(token), config.appSecret)
    if (pass.ok) return { ok: true, userId: pass.userId, queryId: null }
    reason = pass.reason
  }

  json(res, 401, { error: 'unauthorized', reason })
  return null
}

const pickStyle = (v) => (STYLES.includes(v) ? v : config.defaultStyle)

async function serveStatic(res, urlPath) {
  const rel = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '')
  const file = join(PUBLIC_DIR, rel)
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden')
  try {
    const data = await readFile(file)
    const ext = rel.slice(rel.lastIndexOf('.'))
    send(res, 200, data, { 'content-type': MIME[ext] || 'application/octet-stream' })
  } catch {
    send(res, 404, 'not found')
  }
}

export async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const path = url.pathname

  // /api/health — тот же ответ: на бессерверных площадках всё живёт под /api.
  if (req.method === 'GET' && (path === '/health' || path === '/api/health')) {
    return json(res, 200, { ok: true, uptime: Math.round(process.uptime()) })
  }

  // ── разовая привязка бота к этому адресу ──────────────────────────────────
  // На бессерверной площадке нет процесса, который сделал бы это при старте,
  // поэтому есть ручка: открыть один раз в браузере после развёртывания.
  // Повторные вызовы безвредны — вебхук каждый раз ставится на тот же адрес.
  if (path === '/api/setup') {
    try {
      const info = await bootstrap()
      await tg.call('setWebhook', {
        url: config.publicUrl + config.webhookPath,
        secret_token: config.webhookSecret,
        allowed_updates: ['message', 'inline_query'],
        drop_pending_updates: false,
      })
      return send(
        res,
        200,
        `Готово. Бот @${info.username} привязан к ${config.publicUrl}\n\n` +
          'Теперь наберите @' +
          info.username +
          ' в любом чате Telegram.\n' +
          'Если кнопки «Говорить» нет — в @BotFather не выполнен /setinline.',
        { 'content-type': 'text/plain; charset=utf-8' },
      )
    } catch (err) {
      return send(res, 500, 'Не получилось: ' + err.message, {
        'content-type': 'text/plain; charset=utf-8',
      })
    }
  }

  // ── что думает Telegram о нашем вебхуке ───────────────────────────────────
  // Когда «ничего не работает», почти всегда виноват вебхук, и Telegram сам
  // хранит причину последней неудачи. Открывается в браузере.
  if (path === '/api/status') {
    try {
      const [me, hook] = await Promise.all([tg.getMe(), tg.call('getWebhookInfo')])
      const expected = config.publicUrl + config.webhookPath
      const when = (ts) => (ts ? new Date(ts * 1000).toISOString() : '—')
      const lines = [
        `бот:                 @${me.username}`,
        `адрес приложения:    ${config.publicUrl}`,
        `вебхук у Telegram:   ${hook.url || '(не задан)'}`,
        `совпадает с нашим:   ${hook.url === expected ? 'да' : 'НЕТ — откройте /api/setup'}`,
        `ждут обработки:      ${hook.pending_update_count ?? 0}`,
        `типы обновлений:     ${(hook.allowed_updates || ['(все)']).join(', ')}`,
        `inline-запросы:      ${
          !hook.allowed_updates || hook.allowed_updates.includes('inline_query')
            ? 'разрешены'
            : 'НЕ разрешены — откройте /api/setup'
        }`,
        // Подключён ли Upstash, снаружи не видно никак: без него бот выглядит
        // исправным, просто длинный текст молча уходит в буфер. Спрашивать об
        // этом больше негде, поэтому отвечаем здесь.
        `длинный текст:       ${
          !store.isDurable()
            ? 'только «Скопировать» — подключите Upstash в Vercel → Storage'
            : store.usingKv()
              ? 'целиком, до 4096 (хранилище Upstash на месте)'
              : 'целиком, до 4096 (память процесса — свой сервер)'
        }`,
        `последняя ошибка:    ${hook.last_error_message || 'нет'}`,
        `когда:               ${when(hook.last_error_date)}`,
      ]
      return send(res, 200, lines.join('\n'), { 'content-type': 'text/plain; charset=utf-8' })
    } catch (err) {
      return send(res, 500, 'Не получилось: ' + err.message, {
        'content-type': 'text/plain; charset=utf-8',
      })
    }
  }

  // ── Telegram webhook ──────────────────────────────────────────────────────
  if (req.method === 'POST' && path === config.webhookPath) {
    // Подлинность обновления подтверждает заголовок с секретом, который
    // Telegram присылает по договорённости из setWebhook.
    if (req.headers['x-telegram-bot-api-secret-token'] !== config.webhookSecret) {
      return json(res, 401, { error: 'unauthorized' })
    }

    const body = await readBody(req, 2 * 1024 * 1024)
    let update
    try {
      update = JSON.parse(body.toString('utf8'))
    } catch {
      return json(res, 400, { error: 'bad json' })
    }
    // Обработку доводим до конца ДО ответа. На бессерверной площадке функция
    // засыпает сразу после ответа, и брошенная «в фоне» работа не доживает:
    // ответ на inline-запрос просто не уходил, поэтому панель с кнопкой
    // «Говорить» в чатах не появлялась.
    await handleUpdate(update)
    return json(res, 200, { ok: true })
  }

  // ── аудио → грамотный текст ───────────────────────────────────────────────
  if (req.method === 'POST' && path === '/api/stt') {
    const session = auth(req, res)
    if (!session) return

    const audio = await readBody(req, config.maxAudioBytes)
    if (!audio.length) return json(res, 400, { error: 'пустое аудио' })

    const mime = String(req.headers['content-type'] || 'audio/webm')
    const lang = url.searchParams.get('lang') || undefined
    const style = pickStyle(url.searchParams.get('style'))

    try {
      const { raw, text } = await speechToText(audio, { mime, lang, style })
      return json(res, 200, { raw, text })
    } catch (err) {
      console.error('[stt]', err)
      return json(res, 502, { error: err.message })
    }
  }

  // ── причесать текст, распознанный на устройстве ───────────────────────────
  if (req.method === 'POST' && path === '/api/polish') {
    const body = await readBody(req, 256 * 1024).then((b) => safeJson(b))
    if (!body) return json(res, 400, { error: 'bad json' })
    const session = auth(req, res, body)
    if (!session) return

    const text = String(body.text || '').slice(0, 20_000)
    if (!text.trim()) return json(res, 200, { text: '' })
    try {
      return json(res, 200, { text: await polish(text, { style: pickStyle(body.style) }) })
    } catch (err) {
      return json(res, 200, { text }) // не теряем сказанное
    }
  }

  // Длинный текст в строку ввода не влезает — Telegram режет inline-запрос на
  // 256 символах. Поэтому кладём текст сюда и отдаём короткий ключ: в строку
  // уйдёт `#ключ`, а в чат — полный текст, который бот подставит по ключу.
  if (req.method === 'POST' && path === '/api/stash') {
    const session = auth(req, res, body)
    if (!session) return

    const text = String(body.text || '').slice(0, 4096)
    if (!text.trim()) return json(res, 400, { error: 'empty' })

    // Без внешнего KV на бессерверной площадке запись не переживёт соседний
    // запрос — честно говорим «нет», чтобы клиент ушёл в буфер обмена.
    if (!store.isDurable()) return json(res, 200, { id: null, reason: 'no-store' })

    const entry = await store.remember(session.userId, text)
    return json(res, 200, { id: entry?.id ?? null })
  }

  // Отправки на сервере нет намеренно. Единственный способ отдать текст в чат
  // от имени человека — answerWebAppQuery, а он кладёт сообщение «в тот чат,
  // откуда открыли окно»: из чата с ботом это сам бот, а из inline-режима
  // Telegram не выдаёт query_id вовсе. Текст возвращает клиент через строку
  // ввода (switchInlineQuery) или через буфер обмена.

  if (req.method === 'GET') return serveStatic(res, path)
  return send(res, 405, 'method not allowed')
}

function safeJson(buf) {
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    return null
  }
}

export function startServer() {
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('[http]', err)
      if (!res.headersSent) json(res, err.status || 500, { error: err.message })
      else res.end()
    })
  })
  server.listen(config.port, () => {
    console.log(`[http] слушаю :${config.port}  →  ${config.publicUrl}`)
  })
  return server
}
