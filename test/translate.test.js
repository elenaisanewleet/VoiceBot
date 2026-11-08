import test from 'node:test'
import assert from 'node:assert/strict'
import { translateText } from '../src/translate.js'

test('Russian message is translated to Mandarin without losing the tone', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let request
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body)
    return { ok: true, json: async () => ({
      choices: [{ message: { content: '我想和你谈谈这件事。' } }],
    }) }
  }
  const result = await translateText('Я хочу обсудить это с тобой.', 'zh')
  assert.equal(result, '我想和你谈谈这件事。')
  assert.match(request.messages[0].content, /китайский/)
  assert.equal(request.messages[1].content, 'Я хочу обсудить это с тобой.')
})

test('translate refuses unknown language and oversized input', async () => {
  await assert.rejects(() => translateText('hello', 'xx'), /Неизвестный язык/)
  await assert.rejects(() => translateText('a'.repeat(4097), 'zh'), /Слишком длинный/)
  assert.equal(await translateText(' ', 'ru'), '')
})

test('translation API failures are visible rather than returning the source', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => ({ ok: false, status: 429 })
  await assert.rejects(() => translateText('你好', 'ru'), /Превышен лимит/)
})

test('removes thinking tags from translation response', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '<think>hidden</think>«Привет»' } }] }),
  })
  assert.equal(await translateText('你好', 'ru'), 'Привет')
})
