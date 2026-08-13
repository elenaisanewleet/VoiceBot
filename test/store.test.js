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

test('на Vercel без KV запись недолговечна', () => {
  const { VERCEL, KV_REST_API_URL, KV_REST_API_TOKEN } = process.env
  process.env.VERCEL = '1'
  delete process.env.KV_REST_API_URL
  delete process.env.KV_REST_API_TOKEN
  try {
    assert.equal(usingKv(), false)
    assert.equal(isDurable(), false)
  } finally {
    if (VERCEL === undefined) delete process.env.VERCEL
    else process.env.VERCEL = VERCEL
    if (KV_REST_API_URL !== undefined) process.env.KV_REST_API_URL = KV_REST_API_URL
    if (KV_REST_API_TOKEN !== undefined) process.env.KV_REST_API_TOKEN = KV_REST_API_TOKEN
  }
})

test('на Vercel с KV запись долговечна', () => {
  const { VERCEL, KV_REST_API_URL, KV_REST_API_TOKEN } = process.env
  process.env.VERCEL = '1'
  process.env.KV_REST_API_URL = 'https://example.upstash.io'
  process.env.KV_REST_API_TOKEN = 'AX3sASQgN2Y4'
  try {
    assert.equal(usingKv(), true)
    assert.equal(isDurable(), true)
  } finally {
    if (VERCEL === undefined) delete process.env.VERCEL
    else process.env.VERCEL = VERCEL
    if (KV_REST_API_URL === undefined) delete process.env.KV_REST_API_URL
    else process.env.KV_REST_API_URL = KV_REST_API_URL
    if (KV_REST_API_TOKEN === undefined) delete process.env.KV_REST_API_TOKEN
    else process.env.KV_REST_API_TOKEN = KV_REST_API_TOKEN
  }
})

test('отказ KV не теряет фразу — падаем в память', async () => {
  const { VERCEL, KV_REST_API_URL, KV_REST_API_TOKEN } = process.env
  const realFetch = globalThis.fetch
  process.env.VERCEL = '1'
  process.env.KV_REST_API_URL = 'https://example.upstash.io'
  process.env.KV_REST_API_TOKEN = 'AX3sASQgN2Y4'
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
    if (VERCEL === undefined) delete process.env.VERCEL
    else process.env.VERCEL = VERCEL
    if (KV_REST_API_URL === undefined) delete process.env.KV_REST_API_URL
    else process.env.KV_REST_API_URL = KV_REST_API_URL
    if (KV_REST_API_TOKEN === undefined) delete process.env.KV_REST_API_TOKEN
    else process.env.KV_REST_API_TOKEN = KV_REST_API_TOKEN
  }
})
