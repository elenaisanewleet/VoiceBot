import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

// Крошечный .env-загрузчик, чтобы не тянуть зависимость.
function loadDotEnv(path = '.env') {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

loadDotEnv()

const bool = (v, fallback = false) =>
  v === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase())

// На хостингах публичный адрес известен самой платформе — не заставляем
// вписывать его руками. Render отдаёт готовый адрес, Vercel — только домен.
function detectPublicUrl() {
  const explicit = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL
  if (explicit) return explicit
  // У Vercel VERCEL_URL уникален для каждой сборки, а нужен постоянный адрес.
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL
  return host ? `https://${host}` : ''
}

const publicUrl = detectPublicUrl().replace(/\/+$/, '')

/**
 * При вставке значения в поле на сайте хостинга легко прихватить пробел или
 * перенос строки. Токену это почти не мешает — разбор адреса выкидывает
 * переносы, и запросы к Telegram проходят, — но подпись Mini App считается
 * от самого токена и разъезжается. Ошибка при этом выглядит совершенно
 * непонятно: бот работает, а окно с микрофоном отвечает «unauthorized».
 * Поэтому обрезаем всё, что пришло из окружения.
 */
const env = (name, fallback = '') => (process.env[name] ?? fallback).trim()

export const config = {
  botToken: env('BOT_TOKEN'),
  publicUrl,
  miniAppUrl: publicUrl ? `${publicUrl}/` : '',
  port: Number(env('PORT', '8080')),

  stt: {
    apiKey: env('STT_API_KEY'),
    baseUrl: env('STT_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: env('STT_MODEL', 'gpt-4o-mini-transcribe'),
    defaultLang: env('DEFAULT_LANG'),
  },

  // Модель, которая превращает сырую расшифровку в грамотный текст.
  // По умолчанию ходит туда же, куда и распознавание.
  llm: {
    apiKey: env('LLM_API_KEY') || env('STT_API_KEY'),
    baseUrl: (env('LLM_BASE_URL') || env('STT_BASE_URL', 'https://api.openai.com/v1')).replace(
      /\/+$/,
      '',
    ),
    model: env('LLM_MODEL', 'gpt-4o-mini'),
  },

  defaultStyle: env('DEFAULT_STYLE', 'clean'),

  useWebhook: bool(process.env.USE_WEBHOOK, false),
  maxAudioBytes: Number(process.env.MAX_AUDIO_BYTES || 20 * 1024 * 1024),

  // Бесплатные хостинги усыпляют сервис после нескольких минут тишины, и первый
  // запрос потом ждёт около минуты — для Mini App это приговор. Сервис сам
  // дёргает свой /health, чтобы не заснуть.
  keepAlive: bool(process.env.KEEPALIVE, false),
  keepAliveMinutes: Number(process.env.KEEPALIVE_MINUTES || 10),
}

// Путь вебхука не должен быть угадываемым: либо задан явно, либо выводится из токена.
config.webhookSecret =
  process.env.WEBHOOK_SECRET ||
  createHash('sha256').update(`webhook:${config.botToken}`).digest('hex').slice(0, 32)

// Путь лежит под /api, чтобы бессерверные площадки отдавали его в ту же функцию,
// что и остальные ручки.
config.webhookPath = `/api/webhook/${config.webhookSecret}`

export function assertConfig() {
  const problems = []
  if (!config.botToken) problems.push('BOT_TOKEN не задан (возьмите у @BotFather)')
  if (!config.publicUrl) problems.push('PUBLIC_URL не задан')
  else if (!config.publicUrl.startsWith('https://')) {
    problems.push('PUBLIC_URL должен быть https:// — Telegram не откроет Mini App по http, и микрофон не заработает')
  }
  if (!config.stt.apiKey) problems.push('STT_API_KEY не задан (ключ для распознавания речи)')
  if (problems.length) {
    throw new Error('Проверьте .env:\n  - ' + problems.join('\n  - '))
  }
}
