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

const UNREACHABLE =
  'api.telegram.org не отвечает так, как должен. Обычно это сеть: провайдер ' +
  'блокирует Telegram или нужен VPN'

export async function call(method, payload = {}, { timeoutMs = 30_000 } = {}) {
  let res
  try {
    res = await fetch(`${API()}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw new TelegramError(method, `${UNREACHABLE} (${err.name === 'TimeoutError' ? 'таймаут' : err.message})`, 0)
  }

  // Между нами и Telegram может оказаться прокси или заглушка провайдера —
  // тогда вместо JSON придёт HTML, и разбор упадёт непонятной ошибкой.
  const body = await res.text()
  let data
  try {
    data = JSON.parse(body)
  } catch {
    throw new TelegramError(method, `${UNREACHABLE} (HTTP ${res.status})`, res.status)
  }

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

