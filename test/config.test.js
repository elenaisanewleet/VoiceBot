import test from 'node:test'
import assert from 'node:assert/strict'

// Конфиг читается на импорте — окружение выставляем до него.
// Публичный адрес не задаём: проверяем, что он подхватится с хостинга.
process.env.BOT_TOKEN = '123456:TEST-TOKEN'
process.env.STT_API_KEY = 'test-key'
process.env.RENDER_EXTERNAL_URL = 'https://139bot.onrender.com/'
delete process.env.PUBLIC_URL

const { config, assertConfig } = await import('../src/config.js')

test('адрес подхватывается с хостинга, если PUBLIC_URL не задан', () => {
  assert.equal(config.publicUrl, 'https://139bot.onrender.com')
  assert.equal(config.miniAppUrl, 'https://139bot.onrender.com/')
})

test('такой конфигурации хватает для запуска', () => {
  assert.doesNotThrow(() => assertConfig())
})

test('путь вебхука не угадывается и выведен из токена', () => {
  assert.match(config.webhookPath, /^\/webhook\/[0-9a-f]{32}$/)
  assert.ok(!config.webhookPath.includes(config.botToken))
})
