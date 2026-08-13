#!/usr/bin/env node
/**
 * Интерактивная настройка: спрашивает три вещи, проверяет их на живых серверах
 * и пишет .env. Нужен один раз.
 *
 *   npm run setup
 */
import { createInterface } from 'node:readline/promises'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { stdin, stdout } from 'node:process'

const rl = createInterface({ input: stdin, output: stdout })

const bold = (s) => `\x1b[1m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`

const PROVIDERS = {
  1: {
    name: 'Groq — бесплатный тариф, карта при регистрации не нужна',
    baseUrl: 'https://api.groq.com/openai/v1',
    sttModel: 'whisper-large-v3-turbo',
    llmModel: 'openai/gpt-oss-120b',
    keyUrl: 'https://console.groq.com/keys',
    keyHint: 'ключ начинается с gsk_',
  },
  2: {
    name: 'OpenAI — платно, нужна привязанная карта',
    baseUrl: 'https://api.openai.com/v1',
    sttModel: 'gpt-4o-mini-transcribe',
    llmModel: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'ключ начинается с sk-',
  },
  3: {
    name: 'Свой сервер (whisper.cpp, Ollama и подобное)',
    baseUrl: 'http://localhost:8000/v1',
    sttModel: 'whisper-1',
    llmModel: 'qwen2.5:7b',
    keyUrl: null,
    keyHint: 'локальному серверу ключ обычно не нужен — можно оставить пустым',
  },
}

/** Читает существующий .env, чтобы предлагать прошлые значения по умолчанию. */
function readEnv(path = '.env') {
  if (!existsSync(path)) return {}
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return out
}

const mask = (v) => (v && v.length > 8 ? v.slice(0, 4) + '…' + v.slice(-4) : v)

async function ask(question, { fallback = '', secret = false } = {}) {
  const suffix = fallback ? dim(` [${secret ? mask(fallback) : fallback}]`) : ''
  const answer = (await rl.question(`${question}${suffix}: `)).trim()
  return answer || fallback
}

async function checkBotToken(token) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(15_000),
    })
    // Между нами и Telegram может стоять прокси, который отвечает не JSON-ом,
    // — тогда честнее сказать «сеть», чем вывалить ошибку разбора.
    const body = await res.text()
    let data
    try {
      data = JSON.parse(body)
    } catch {
      return { ok: false, reason: `сервер ответил не по-телеграмному (HTTP ${res.status})` }
    }
    if (!data.ok) return { ok: false, reason: data.description || `HTTP ${res.status}` }
    return { ok: true, username: data.result.username }
  } catch (err) {
    return { ok: false, reason: err.name === 'TimeoutError' ? 'Telegram не ответил' : err.message }
  }
}

async function checkApiKey(baseUrl, key) {
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(15_000),
    })
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'ключ отклонён' }
    if (!res.ok) return { ok: false, reason: `сервер ответил HTTP ${res.status}` }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err.message }
  }
}

function render(values) {
  return `# Создано командой npm run setup

BOT_TOKEN=${values.BOT_TOKEN}

# https-адрес, на котором открыт сервер.
# При запуске через npm run dev эта строка перезаписывается автоматически.
PUBLIC_URL=${values.PUBLIC_URL}

PORT=${values.PORT}

# ── распознавание речи ──────────────────────────────────────────────────────
STT_API_KEY=${values.STT_API_KEY}
STT_BASE_URL=${values.STT_BASE_URL}
STT_MODEL=${values.STT_MODEL}
DEFAULT_LANG=${values.DEFAULT_LANG}

# ── редактура: сырая расшифровка → грамотный текст ──────────────────────────
LLM_API_KEY=${values.LLM_API_KEY}
LLM_BASE_URL=${values.LLM_BASE_URL}
LLM_MODEL=${values.LLM_MODEL}
DEFAULT_STYLE=${values.DEFAULT_STYLE}

# webhook нужен на боевом сервере; локально оставьте false
USE_WEBHOOK=false
`
}

async function main() {
  if (!stdin.isTTY) {
    console.error(red('Эта настройка задаёт вопросы, поэтому её нужно запускать в терминале.'))
    console.error(dim('Если правите файл сами — скопируйте .env.example в .env и заполните его.'))
    process.exitCode = 1
    return
  }

  const old = readEnv()
  console.log(`\n${bold('Настройка 139bot')}\n`)

  // ── 1. Токен бота ─────────────────────────────────────────────────────────
  console.log(bold('1. Токен бота'))
  console.log(dim('   Откройте в Telegram @BotFather → /newbot → скопируйте токен.\n'))

  let botToken = ''
  let username = ''
  for (;;) {
    botToken = await ask('   Токен', { fallback: old.BOT_TOKEN, secret: true })
    if (!botToken) {
      console.log(red('   Без токена бот не запустится.\n'))
      continue
    }
    process.stdout.write(dim('   проверяю… '))
    const check = await checkBotToken(botToken)
    if (check.ok) {
      username = check.username
      console.log(green(`это @${username}\n`))
      break
    }
    console.log(red(`не подошёл: ${check.reason}\n`))
    if ((await ask('   Ввести другой токен? (д/н)', { fallback: 'д' })).toLowerCase() !== 'д') break
  }

  // ── 2. Распознавание ──────────────────────────────────────────────────────
  console.log(bold('2. Распознавание речи'))
  for (const [key, p] of Object.entries(PROVIDERS)) console.log(`   ${key}) ${p.name}`)
  console.log('')

  const choice = await ask('   Вариант', { fallback: '1' })
  const provider = PROVIDERS[choice] || PROVIDERS[1]
  if (provider.keyUrl) console.log(dim(`\n   Ключ берётся здесь: ${provider.keyUrl}`))
  console.log(dim(`   ${provider.keyHint}\n`))

  let apiKey = ''
  for (;;) {
    apiKey = await ask('   Ключ', { fallback: old.STT_API_KEY, secret: true })
    if (!apiKey && provider.keyUrl) {
      console.log(red('   Без ключа распознавать нечем.\n'))
      continue
    }
    process.stdout.write(dim('   проверяю… '))
    const check = await checkApiKey(provider.baseUrl, apiKey)
    if (check.ok) {
      console.log(green('принят\n'))
      break
    }
    console.log(yellow(`не удалось проверить: ${check.reason}\n`))
    if ((await ask('   Ввести другой ключ? (д/н)', { fallback: 'д' })).toLowerCase() !== 'д') break
  }

  // ── 3. Язык ───────────────────────────────────────────────────────────────
  console.log(bold('3. Язык, на котором вы обычно говорите'))
  console.log(dim('   Код языка: ru, en, uk, de… Пусто — определять автоматически.\n'))
  const lang = await ask('   Язык', { fallback: old.DEFAULT_LANG ?? 'ru' })

  const values = {
    BOT_TOKEN: botToken,
    PUBLIC_URL: old.PUBLIC_URL || '',
    PORT: old.PORT || '8080',
    STT_API_KEY: apiKey,
    STT_BASE_URL: provider.baseUrl,
    STT_MODEL: provider.sttModel,
    DEFAULT_LANG: lang,
    LLM_API_KEY: apiKey,
    LLM_BASE_URL: provider.baseUrl,
    LLM_MODEL: provider.llmModel,
    DEFAULT_STYLE: old.DEFAULT_STYLE || 'clean',
  }

  writeFileSync('.env', render(values), { mode: 0o600 })

  console.log(green('\n✓ Файл .env записан.\n'))
  console.log(bold('Что осталось сделать один раз:'))
  console.log(`   1. В @BotFather выполните ${bold('/setinline')}, выберите ${username ? '@' + username : 'вашего бота'}`)
  console.log(dim('      и задайте подсказку, например: Говорите — отправлю текстом'))
  console.log(dim('      Без этого @бот в чужих чатах работать не будет.\n'))
  console.log(`   2. Запустите: ${bold('npm run dev')}`)
  console.log(dim('      Команда сама поднимет https-туннель и пропишет адрес в .env.\n'))
}

main()
  .catch((err) => {
    console.error(red('\nНе получилось: ' + err.message))
    process.exitCode = 1
  })
  .finally(() => rl.close())
