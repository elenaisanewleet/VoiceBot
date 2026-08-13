import test from 'node:test'
import assert from 'node:assert/strict'

import { remember, recent, get, isDurable, usingKv, _reset } from '../src/store.js'

test('хранит последние фразы пользователя в порядке свежести', async () => {
  _reset()
  await remember(1, 'первая')
  await remember(1, 'вторая')
  const items = await recent(1)
  assert.equal(items.length, 2)
  assert.equal(items[0].text, 'вторая')
})

test('не смешивает пользователей', async () => {
  _reset()
  const mine = await remember(1, 'моё')
  await remember(2, 'чужое')
  assert.equal((await recent(1)).length, 1)
  assert.equal(await get(2, mine.id), null)
  assert.equal((await get(1, mine.id)).text, 'моё')
})

test('держит не больше пяти фраз', async () => {
  _reset()
  for (let i = 0; i < 9; i++) await remember(1, `фраза ${i}`)
  const items = await recent(1)
  assert.equal(items.length, 5)
  assert.equal(items[0].text, 'фраза 8')
})

test('игнорирует пустое', async () => {
  _reset()
  assert.equal(await remember(1, ''), null)
  assert.equal(await remember(null, 'текст'), null)
  assert.equal((await recent(1)).length, 0)
})

test('выдаёт уникальные идентификаторы', async () => {
  _reset()
  const ids = new Set()
  for (let i = 0; i < 5; i++) ids.add((await remember(1, `x${i}`)).id)
  assert.equal(ids.size, 5)
})

// ── долговечность ───────────────────────────────────────────────────────────
// От неё зависит, можно ли отдавать в чат короткий ключ вместо текста: если
// соседний запрос запись не увидит, человеку прилетит «#t3k9» вместо фразы.

test('на своём сервере памяти достаточно', () => {
  const vercel = process.env.VERCEL
  delete process.env.VERCEL
  try {
    assert.equal(isDurable(), true)
  } finally {
    if (vercel !== undefined) process.env.VERCEL = vercel
  }
})

// Окружение общее на весь процесс, а тесты идут в одном: не вернёшь как было —
// соседний тест увидит чужое хранилище и упадёт не по своей вине. Поэтому все
// имена, влияющие на выбор хранилища, перечислены разом и чистятся разом: с
// двумя наборами имён (KV_* и UPSTASH_*) забыть одно стало слишком легко.
const ENV_KEYS = [
  'VERCEL',
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
]

async function withEnv(patch, fn) {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]])
  for (const key of ENV_KEYS) delete process.env[key]
  Object.assign(process.env, patch)
  try {
    return await fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const KV_ENV = {
  VERCEL: '1',
  KV_REST_API_URL: 'https://example.upstash.io',
  KV_REST_API_TOKEN: 'AX3sASQgN2Y4',
}

test('на Vercel без KV запись недолговечна', () =>
  withEnv({ VERCEL: '1' }, () => {
    assert.equal(usingKv(), false)
    assert.equal(isDurable(), false)
  }))

test('на Vercel с KV запись долговечна', () =>
  withEnv(KV_ENV, () => {
    assert.equal(usingKv(), true)
    assert.equal(isDurable(), true)
  }))

// Интеграция Upstash из Marketplace называет переменные по-своему. Промах здесь
// не ломает бота, а тихо отключает длинный текст — снаружи всё выглядит целым,
// поэтому проверяем оба набора имён, а не только тот, что был первым.
test('имена от Marketplace тоже включают KV', () =>
  withEnv(
    {
      VERCEL: '1',
      UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'AX3sASQgN2Y4',
    },
    () => {
      assert.equal(usingKv(), true)
      assert.equal(isDurable(), true)
    },
  ))

test('отказ KV не теряет фразу — падаем в память', () =>
  withEnv(KV_ENV, async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = async () => {
      throw new Error('сеть недоступна')
    }
    _reset()
    try {
      const entry = await remember(7, 'фраза')
      assert.ok(entry, 'запись должна вернуться, даже когда KV молчит')
      assert.equal(entry.text, 'фраза')
    } finally {
      globalThis.fetch = realFetch
    }
  }))
