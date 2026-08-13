import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'

// Ровно та ошибка, из-за которой Mini App отвечал «unauthorized» на боевом
// хостинге: при вставке в поле на сайте к токену прилипал перенос строки.
// Запросы к Telegram при этом проходили — разбор адреса выкидывает переносы, —
// а подпись Mini App считается от самого токена и переставала сходиться.
const CLEAN_TOKEN = '123456:TEST-TOKEN-abcdef'
process.env.BOT_TOKEN = `  ${CLEAN_TOKEN}\n`
process.env.STT_API_KEY = ' gsk_test \n'
process.env.STT_BASE_URL = ' https://api.groq.com/openai/v1 '
process.env.PUBLIC_URL = 'https://voicebot.example'

const { config } = await import('../src/config.js')
const { verifyInitData } = await import('../src/initData.js')

test('пробелы и переносы вокруг значений из окружения обрезаются', () => {
  assert.equal(config.botToken, CLEAN_TOKEN)
  assert.equal(config.stt.apiKey, 'gsk_test')
  assert.equal(config.stt.baseUrl, 'https://api.groq.com/openai/v1')
})

test('подпись Mini App сходится, хотя в окружении токен был с переносом', () => {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAH123',
    user: JSON.stringify({ id: 42, first_name: 'Елена' }),
  })
  const checkString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(CLEAN_TOKEN).digest()
  params.set('hash', createHmac('sha256', secret).update(checkString).digest('hex'))

  const result = verifyInitData(params.toString(), config.botToken)
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.userId, 42)
})
