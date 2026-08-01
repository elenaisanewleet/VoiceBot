import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Проверка подписи initData из Telegram Mini App.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Без этой проверки любой смог бы отправлять сообщения от чужого имени —
 * поэтому все ручки /api/* ходят только через неё.
 */
export function verifyInitData(initData, botToken, { maxAgeSec = 24 * 60 * 60 } = {}) {
  if (typeof initData !== 'string' || !initData) {
    return { ok: false, reason: 'initData отсутствует' }
  }

  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) return { ok: false, reason: 'нет hash' }

  params.delete('hash')
  params.delete('signature') // подпись Telegram для third-party валидации, в контрольную строку не входит

  const checkString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n')

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest()
  const expected = createHmac('sha256', secret).update(checkString).digest('hex')

  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(hash, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'подпись не сходится' }
  }

  const authDate = Number(params.get('auth_date') || 0)
  if (!authDate) return { ok: false, reason: 'нет auth_date' }
  const ageSec = Math.floor(Date.now() / 1000) - authDate
  if (ageSec > maxAgeSec) return { ok: false, reason: 'initData просрочен' }

  let user = null
  try {
    user = JSON.parse(params.get('user') || 'null')
  } catch {
    /* пользователя может не быть — например, при запуске из канала */
  }

  return {
    ok: true,
    user,
    userId: user?.id ?? null,
    queryId: params.get('query_id'),
    chatType: params.get('chat_type'),
    authDate,
  }
}
