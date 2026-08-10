import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { once } from 'node:events'

// Конфиг читается на импорте — переменные окружения выставляем до него.
process.env.BOT_TOKEN = '123456:TEST-TOKEN-abcdef'
process.env.PUBLIC_URL = 'https://example.test'
process.env.STT_API_KEY = 'test-key'
process.env.PORT = '0'

const { startServer } = await import('../src/server.js')
const { config } = await import('../src/config.js')
const { mintToken } = await import('../src/token.js')

const TOKEN = process.env.BOT_TOKEN
let base
let server

before(async () => {
  server = startServer()
  await once(server, 'listening')
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => server?.close())

function initDataFor(fields) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 777, first_name: 'Тест' }),
    ...fields,
  })
  const checkString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest()
  params.set('hash', createHmac('sha256', secret).update(checkString).digest('hex'))
  return params.toString()
}

const post = (path, body) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

test('health отвечает', async () => {
  const res = await fetch(base + '/health')
  assert.equal(res.status, 200)
  assert.equal((await res.json()).ok, true)
})

test('отдаёт Mini App с корня', async () => {
  const res = await fetch(base + '/')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/html/)
  assert.match(await res.text(), /telegram-web-app\.js/)
})

test('не выпускает за пределы public/', async () => {
  const res = await fetch(base + '/../src/config.js')
  assert.ok(res.status === 404 || res.status === 403, `неожиданный статус ${res.status}`)
  assert.doesNotMatch(await res.text(), /BOT_TOKEN/)
})

test('без подписи в api не пускает', async () => {
  const res = await post('/api/polish', { text: 'привет' })
  assert.equal(res.status, 401)
  const stt = await fetch(base + '/api/stt', { method: 'POST', body: 'x' })
  assert.equal(stt.status, 401)
})

test('с чужой подписью не пускает', async () => {
  const forged = initDataFor({}).replace(/hash=.*/, 'hash=' + 'a'.repeat(64))
  const res = await post('/api/polish', { initData: forged, text: 'привет' })
  assert.equal(res.status, 401)
})

test('пропуск из адреса кнопки пускает вместо данных запуска', async () => {
  const token = mintToken(777, config.appSecret)
  // Пустой текст причёсывать нечего — ответ приходит до похода к модели,
  // поэтому проверка касается ровно того, ради чего написана: кого пустили.
  const res = await post('/api/polish', { token, text: '' })
  assert.equal(res.status, 200)

  // Тот же пропуск заголовком — так его шлёт запись голоса, у которой тело
  // занято звуком.
  const stt = await fetch(base + '/api/stt', {
    method: 'POST',
    headers: { 'x-app-token': token, 'content-type': 'audio/webm' },
    body: '',
  })
  assert.notEqual(stt.status, 401) // пустое аудио — уже другая история
})

test('данные запуска не отменяются мусорным пропуском', async () => {
  // Из чата с ботом окно получает и то и другое: проверять надо оба, пока
  // хоть одно не подойдёт.
  const res = await post('/api/polish', {
    initData: initDataFor({}),
    token: 'мусор.мусор',
    text: '',
  })
  assert.equal(res.status, 200)
})

test('поддельный пропуск не пускает', async () => {
  const [payload] = mintToken(777, config.appSecret).split('.')
  const res = await post('/api/polish', { token: `${payload}.${'x'.repeat(32)}`, text: '' })
  assert.equal(res.status, 401)
  assert.match((await res.json()).reason, /подделан/)
})
