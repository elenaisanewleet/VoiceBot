import { config, assertConfig } from './config.js'
import * as tg from './telegram.js'
import { handleUpdate, bootstrap } from './bot.js'
import { startServer } from './server.js'

const ALLOWED_UPDATES = ['message', 'inline_query']

let running = true

async function longPolling() {
  await tg.call('deleteWebhook', { drop_pending_updates: false }).catch(() => {})
  console.log('[bot] режим: long polling')

  let offset = 0
  let backoff = 1000

  while (running) {
    try {
      const updates = await tg.call(
        'getUpdates',
        { offset, timeout: 30, allowed_updates: ALLOWED_UPDATES },
        { timeoutMs: 40_000 },
      )
      backoff = 1000
      for (const update of updates) {
        offset = update.update_id + 1
        handleUpdate(update) // не ждём: медленное распознавание не должно тормозить очередь
      }
    } catch (err) {
      if (!running) break
      console.error('[poll]', err.message)
      await new Promise((r) => setTimeout(r, backoff))
      backoff = Math.min(backoff * 2, 30_000)
    }
  }
}

async function webhook() {
  const url = config.publicUrl + config.webhookPath
  await tg.call('setWebhook', {
    url,
    secret_token: config.webhookSecret,
    allowed_updates: ALLOWED_UPDATES,
    max_connections: 40,
  })
  console.log(`[bot] режим: webhook → ${config.publicUrl}/webhook/***`)
}

/**
 * Не даём бесплатному хостингу усыпить сервис: раз в несколько минут дёргаем
 * собственный /health через публичный адрес. Для платного инстанса не нужно —
 * включается переменной KEEPALIVE.
 */
function startKeepAlive() {
  const everyMs = Math.max(1, config.keepAliveMinutes) * 60_000
  console.log(`[bot] не засыпаю: пингую себя раз в ${config.keepAliveMinutes} мин`)
  const timer = setInterval(() => {
    fetch(`${config.publicUrl}/health`, { signal: AbortSignal.timeout(20_000) }).catch((err) =>
      console.warn('[keepalive]', err.message),
    )
  }, everyMs)
  timer.unref()
}

async function main() {
  assertConfig()
  startServer()
  await bootstrap()
  if (config.keepAlive) startKeepAlive()
  if (config.useWebhook) await webhook()
  else await longPolling()
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    running = false
    console.log(`\n[bot] ${signal} — останавливаюсь`)
    setTimeout(() => process.exit(0), 200).unref()
  })
}

main().catch((err) => {
  console.error('\n' + err.message + '\n')
  process.exit(1)
})
