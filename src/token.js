import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Пропуск для окна записи, открытого из панели в чужом чате.
 *
 * Telegram в этом случае не передаёт окну данных запуска — ни кто открыл, ни
 * откуда. Но inline-запрос приходит на сервер вместе с идентификатором
 * пользователя, так что пропуск можно выписать самому и вшить в адрес кнопки.
 * Подделать его нельзя: подпись считается секретом, выведенным из токена бота.
 */
const TTL_SEC = 60 * 60

const sign = (payload, secret) =>
  createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 32)

export function mintToken(userId, secret, ttlSec = TTL_SEC) {
  const payload = Buffer.from(
    JSON.stringify({ u: userId, e: Math.floor(Date.now() / 1000) + ttlSec }),
  ).toString('base64url')
  return `${payload}.${sign(payload, secret)}`
}

export function verifyToken(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, reason: 'пропуск отсутствует' }
  }

  const [payload, given] = token.split('.')
  const expected = sign(payload, secret)
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'пропуск подделан' }
  }

  let data
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'пропуск испорчен' }
  }

  if (!data.e || data.e < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: 'пропуск просрочен — наберите бота в чате заново' }
  }
  return { ok: true, userId: data.u }
}
