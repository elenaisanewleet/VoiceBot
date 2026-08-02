#!/usr/bin/env node
/**
 * Запуск на ноутбуке одной командой.
 *
 * Telegram открывает Mini App только по https, а на локальной машине его нет.
 * Поэтому скрипт поднимает временный https-туннель до localhost, забирает
 * выданный адрес, прописывает его в .env и запускает бота. Адрес у бесплатного
 * туннеля меняется при каждом запуске — в этом и смысл автоматизации.
 *
 *   npm run dev
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const bold = (s) => `\x1b[1m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`

const URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i
const TUNNEL_TIMEOUT_MS = 90_000

if (!existsSync('.env')) {
  console.error(red('Нет файла .env. Сначала выполните: npm run setup'))
  process.exit(1)
}

const envText = readFileSync('.env', 'utf8')
const port = (envText.match(/^PORT=(.*)$/m)?.[1] || '8080').trim() || '8080'

let children = []
let stopping = false

function stopAll(code = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
  setTimeout(() => process.exit(code), 300).unref()
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stopAll(0))

function startTunnel() {
  return new Promise((resolve, reject) => {
    console.log(dim(`Поднимаю https-туннель до localhost:${port}…`))

    let tunnel
    try {
      tunnel = spawn(
        'cloudflared',
        ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch (err) {
      return reject(err)
    }
    children.push(tunnel)

    let resolved = false
    const timer = setTimeout(() => {
      if (!resolved) reject(new Error('туннель не отдал адрес за полторы минуты'))
    }, TUNNEL_TIMEOUT_MS)

    const scan = (buf) => {
      const found = String(buf).match(URL_RE)
      if (found && !resolved) {
        resolved = true
        clearTimeout(timer)
        resolve(found[0])
      }
    }
    tunnel.stdout.on('data', scan)
    tunnel.stderr.on('data', scan)

    tunnel.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    tunnel.on('exit', (code) => {
      if (!resolved) {
        clearTimeout(timer)
        reject(new Error(`cloudflared завершился с кодом ${code}`))
      } else if (!stopping) {
        console.error(red('\nТуннель отвалился. Остановите (Ctrl+C) и запустите заново.'))
      }
    })
  })
}

function savePublicUrl(url) {
  const line = `PUBLIC_URL=${url}`
  const updated = /^PUBLIC_URL=.*$/m.test(envText)
    ? envText.replace(/^PUBLIC_URL=.*$/m, line)
    : envText.trimEnd() + '\n' + line + '\n'
  writeFileSync('.env', updated, { mode: 0o600 })
}

function startBot(url) {
  const bot = spawn(process.execPath, ['src/index.js'], {
    stdio: 'inherit',
    env: { ...process.env, PUBLIC_URL: url },
  })
  children.push(bot)
  bot.on('exit', (code) => stopAll(code ?? 0))
}

try {
  const url = await startTunnel()
  savePublicUrl(url)
  console.log(green(`\n✓ Адрес получен: ${url}`))
  console.log(dim('  Он записан в .env и живёт, пока команда не остановлена.\n'))
  startBot(url)
  console.log(dim('Готово. Наберите @вашего_бота в любом чате Telegram.'))
  console.log(dim('Остановить — Ctrl+C.\n'))
} catch (err) {
  if (err.code === 'ENOENT') {
    console.error(red('\nНе найден cloudflared — им поднимается https-туннель.'))
    console.error('Установите его одной командой:\n')
    console.error(bold('   brew install cloudflared\n'))
    console.error(dim('Если нет Homebrew: https://brew.sh — там одна строка для установки.'))
    console.error(dim('Альтернатива без установки: npx localtunnel --port ' + port))
    console.error(dim('(тогда полученный адрес нужно самому вписать в PUBLIC_URL и запустить npm start)'))
  } else {
    console.error(red('\nТуннель не поднялся: ' + err.message))
  }
  stopAll(1)
}
