/**
 * Последние распознанные фразы пользователя.
 * Нужны для двух вещей:
 *   1) запасной сценарий switchInlineQuery — текст длиннее лимита inline-строки
 *      не влезает в поле ввода, поэтому передаём короткий ключ, а текст берём отсюда;
 *   2) `@бот` без запроса показывает последние фразы — можно переслать ещё раз.
 *
 * Хранилище в памяти: перезапуск чистит историю, и это осознанно — расшифровки
 * чужой речи незачем складывать на диск.
 */
const TTL_MS = 60 * 60 * 1000
const PER_USER = 5
const MAX_USERS = 5000

const byUser = new Map() // userId -> [{ id, text, at }]
let counter = 0

const nextId = () => `t${Date.now().toString(36)}${(counter++).toString(36)}`

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

export function remember(userId, text) {
  if (!userId || !text) return null
  prune()
  const entry = { id: nextId(), text, at: Date.now() }
  const items = byUser.get(userId) || []
  items.unshift(entry)
  byUser.set(userId, items.slice(0, PER_USER))
  return entry
}

export function recent(userId) {
  if (!userId) return []
  prune()
  return byUser.get(userId) || []
}

export function get(userId, id) {
  return recent(userId).find((i) => i.id === id) || null
}

export function _reset() {
  byUser.clear()
}
