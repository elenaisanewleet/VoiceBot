import { config } from './config.js'

const API = () => `https://api.telegram.org/bot${config.botToken}`
const FILE_API = () => `https://api.telegram.org/file/bot${config.botToken}`

export class TelegramError extends Error {
  constructor(method, description, code) {
    super(`Telegram ${method} → ${code}: ${description}`)
    this.name = 'TelegramError'
    this.method = method
    this.code = code
    this.description = description
  }
}

export async function call(method, payload = {}, { timeoutMs = 30_000 } = {}) {
  const res = await fetch(`${API()}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const data = await res.json().catch(() => ({ ok: false, description: 'некорректный JSON от Telegram' }))
  if (!data.ok) throw new TelegramError(method, data.description, data.error_code ?? res.status)
  return data.result
}

/** Скачать файл, присланный пользователем (голосовое, аудио, кружок). */
export async function downloadFile(fileId) {
  const file = await call('getFile', { file_id: fileId })
  const res = await fetch(`${FILE_API()}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`не удалось скачать файл: HTTP ${res.status}`)
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    path: file.file_path,
  }
}

export const getMe = () => call('getMe')

export const sendMessage = (chatId, text, extra = {}) =>
  call('sendMessage', { chat_id: chatId, text, ...extra })

export const answerInlineQuery = (inlineQueryId, results, extra = {}) =>
  call('answerInlineQuery', { inline_query_id: inlineQueryId, results, ...extra })

/**
 * Отправляет сообщение в тот чат, откуда пользователь открыл Mini App.
 * Работает только если Mini App был открыт кнопкой из inline-режима —
 * именно в этом случае Telegram кладёт query_id в initData.
 */
export const answerWebAppQuery = (webAppQueryId, result) =>
  call('answerWebAppQuery', { web_app_query_id: webAppQueryId, result })
