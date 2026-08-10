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

  const checkString = (entries) =>
    entries
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n')

  const entries = [...params.entries()]
  // При проверке по токену бота в контрольную строку входят все поля, кроме
  // hash, — включая signature. Исключение signature относится к другому
  // способу проверки, стороннему, по открытому ключу Telegram. Второй вариант
  // всё же считаем: клиенты постарше поле signature не присылают вовсе, а
  // ошибка тут выглядит как «подпись не сходится» и ищется мучительно.
  const variants = [
    checkString(entries),
    checkString(entries.filter(([k]) => k !== 'signature')),
  ]

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest()
  const given = Buffer.from(hash, 'hex')
  const matches = variants.some((data) => {
    const expected = Buffer.from(createHmac('sha256', secret).update(data).digest('hex'), 'hex')
    return expected.length === given.length && timingSafeEqual(expected, given)
  })

  if (!matches) {
    // Подпись считается от токена бота, так что расходится она почти всегда
    // по одной причине — в BOT_TOKEN лежит не то, что выдал @BotFather.
    return { ok: false, reason: 'подпись не сходится — проверьте BOT_TOKEN на хостинге' }
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
