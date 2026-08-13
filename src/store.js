/**
 * Последние распознанные фразы пользователя.
 * Нужны для двух вещей:
 *   1) запасной сценарий switchInlineQuery — текст длиннее лимита inline-строки
 *      не влезает в поле ввода, поэтому передаём короткий ключ, а текст берём отсюда;
 *   2) `@бот` без запроса показывает последние фразы — можно переслать ещё раз.
 *
 * Память процесса для этого годится только на своём сервере. На бессерверной
 * площадке каждый запрос — новый процесс: пока человек говорит и пока выбирает
 * чат, это разные запуски, и записанное первым второй уже не видит. Поэтому,
 * если заданы KV_REST_API_URL и KV_REST_API_TOKEN (их проставляет Vercel при
 * подключении Upstash Redis), храним во внешнем KV, а без них — как раньше,
 * в памяти. Расшифровки чужой речи живут час и на диск не ложатся.
 */
const TTL_MS = 60 * 60 * 1000
const TTL_SEC = TTL_MS / 1000
const PER_USER = 5
const MAX_USERS = 5000

const byUser = new Map() // userId -> [{ id, text, at }]
let counter = 0

const nextId = () => `t${Date.now().toString(36)}${(counter++).toString(36)}`

const kvUrl = () => (process.env.KV_REST_API_URL || '').replace(/\/+$/, '')
const kvToken = () => process.env.KV_REST_API_TOKEN || ''
export const usingKv = () => Boolean(kvUrl() && kvToken())

/**
 * Переживёт ли запись соседний запрос. На своём сервере процесс один и памяти
 * достаточно; на Vercel — только с внешним KV.
 */
export const isDurable = () => usingKv() || !process.env.VERCEL

const keyFor = (userId) => `v139:${userId}`

async function kvFetch(path, init = {}) {
  const res = await fetch(`${kvUrl()}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${kvToken()}`, ...(init.headers || {}) },
  })
  if (!res.ok) throw new Error(`KV ${res.status}`)
  return res.json()
}

async function kvRead(userId) {
  const { result } = await kvFetch(`/get/${encodeURIComponent(keyFor(userId))}`)
  if (!result) return []
  try {
    const items = JSON.parse(result)
    return Array.isArray(items) ? items : []
  } catch {
    return []
  }
}

async function kvWrite(userId, items) {
  await kvFetch(`/set/${encodeURIComponent(keyFor(userId))}?EX=${TTL_SEC}`, {
    method: 'POST',
    body: JSON.stringify(items),
  })
}

function prune() {
  const cutoff = Date.now() - TTL_MS
  for (const [userId, items] of byUser) {
    const fresh = items.filter((i) => i.at >= cutoff)
    if (fresh.length) byUser.set(userId, fresh)
    else byUser.delete(userId)
  }
  // Аварийный предохранитель от неограниченного роста.
  if (byUser.size > MAX_USERS) {
    const excess = byUser.size - MAX_USERS
    let n = 0
    for (const key of byUser.keys()) {
      byUser.delete(key)
      if (++n >= excess) break
    }
  }
}

export async function remember(userId, text) {
  if (!userId || !text) return null
  const entry = { id: nextId(), text, at: Date.now() }

  if (usingKv()) {
    // Отказ хранилища не должен ронять распознавание: текст человек уже видит
    // на экране и может его скопировать. Молча теряем только кнопку пересылки.
    try {
      const items = [entry, ...(await kvRead(userId))].slice(0, PER_USER)
      await kvWrite(userId, items)
      return entry
    } catch (err) {
      console.error('[store] KV недоступен, кладу в память:', err.message)
    }
  }

  prune()
  const items = byUser.get(userId) || []
  items.unshift(entry)
  byUser.set(userId, items.slice(0, PER_USER))
  return entry
}

export async function recent(userId) {
  if (!userId) return []
  if (usingKv()) {
    try {
      const cutoff = Date.now() - TTL_MS
      return (await kvRead(userId)).filter((i) => i.at >= cutoff)
    } catch (err) {
      console.error('[store] KV недоступен при чтении:', err.message)
    }
  }
  prune()
  return byUser.get(userId) || []
}

export async function get(userId, id) {
  return (await recent(userId)).find((i) => i.id === id) || null
}

export function _reset() {
  byUser.clear()
}
