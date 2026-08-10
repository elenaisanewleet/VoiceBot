import { config } from './config.js'
import * as tg from './telegram.js'
import * as store from './store.js'
import { speechToText } from './stt.js'

const MAX_MESSAGE = 4096
const MAX_INLINE_QUERY = 200 // у Telegram лимит 256, оставляем запас на @username

const HELP =
  'Я превращаю вашу речь в грамотный текст прямо в чате.\n\n' +
  'Как пользоваться в переписке с любым человеком:\n' +
  '1. В любом чате наберите в поле ввода @%USERNAME%\n' +
  '2. Над клавиатурой появится кнопка «🎙 Говорить» — нажмите её.\n' +
  '3. Говорите. Текст пишется на глазах, пунктуация и падежи — на мне.\n' +
  '4. «Отправить» — и сообщение уходит в этот же чат обычным текстом от вас.\n\n' +
  'Бота никуда добавлять не нужно, права в чате не нужны, собеседник ничего не настраивает.\n\n' +
  'Ещё можно просто прислать мне голосовое сюда — верну расшифровку с кнопкой ' +
  '«отправить в чат».'

let meCache = null
export async function me() {
  if (!meCache) meCache = await tg.getMe()
  return meCache
}

function chunk(text, size = MAX_MESSAGE) {
  const parts = []
  let rest = text
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size)
    if (cut < size * 0.5) cut = rest.lastIndexOf(' ', size)
    if (cut < size * 0.5) cut = size
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut).trimStart()
  }
  if (rest) parts.push(rest)
  return parts
}

const preview = (text, n = 90) => (text.length > n ? text.slice(0, n - 1) + '…' : text)

/** Кнопка, которая открывает Mini App с микрофоном. */
const micButton = () => ({ text: '🎙 Говорить', web_app: { url: config.miniAppUrl } })

/** Кнопка «вставить этот текст в любой чат» — Telegram сам покажет выбор чата. */
function sendToChatButton(entry) {
  const query = entry.text.length <= MAX_INLINE_QUERY ? entry.text : `#${entry.id}`
  return { text: '📨 Отправить в чат', switch_inline_query: query }
}

// ── inline: @бот в любом чате ───────────────────────────────────────────────

export async function onInlineQuery(q) {
  const userId = q.from?.id
  const raw = (q.query || '').trim()
  const results = []

  // Текст мог не влезть в строку запроса — тогда пришёл короткий ключ.
  const byKey = raw.startsWith('#')
  const stored = byKey ? store.get(userId, raw.slice(1)) : null
  // Ключ без записи — на бессерверной площадке память между запросами не
  // живёт. Отправлять в чат сам ключ вместо текста было бы издевательством.
  const text = byKey ? (stored?.text ?? '') : raw

  if (text) {
    results.push({
      type: 'article',
      id: 'send',
      title: 'Отправить сообщение',
      description: preview(text, 120),
      input_message_content: { message_text: text },
    })
  } else {
    for (const entry of store.recent(userId)) {
      results.push({
        type: 'article',
        id: entry.id,
        title: preview(entry.text, 60),
        description: 'последнее распознанное — отправить ещё раз',
        input_message_content: { message_text: entry.text },
      })
    }
  }

  await tg.answerInlineQuery(q.id, results, {
    // Главное здесь: кнопка над списком открывает Mini App с микрофоном
    // прямо поверх текущего чата.
    button: { text: '🎙 Говорить — речь превратится в текст', web_app: { url: config.miniAppUrl } },
    cache_time: 0,
    is_personal: true,
  })
}

// ── личка с ботом ───────────────────────────────────────────────────────────

const VOICE_FIELDS = ['voice', 'audio', 'video_note']

function extractAudio(msg) {
  for (const field of VOICE_FIELDS) {
    if (msg[field]) return { fileId: msg[field].file_id, mime: msg[field].mime_type }
  }
  if (msg.document && /^(audio|video)\//.test(msg.document.mime_type || '')) {
    return { fileId: msg.document.file_id, mime: msg.document.mime_type }
  }
  return null
}

export async function onMessage(msg) {
  const chatId = msg.chat?.id
  if (!chatId) return
  const userId = msg.from?.id

  const audio = extractAudio(msg)
  if (audio) return handleVoice(msg, audio)

  const text = (msg.text || '').trim()
  if (!text) return

  if (text.startsWith('/')) {
    const info = await me()
    await tg.sendMessage(chatId, HELP.replaceAll('%USERNAME%', info.username), {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📨 Выбрать чат и начать', switch_inline_query: '' }],
          [micButton()],
        ],
      },
    })
    return
  }

  // Любой другой текст в личке — это, скорее всего, попытка что-то отправить:
  // сохраним и дадим кнопку пересылки.
  const entry = store.remember(userId, text)
  await tg.sendMessage(chatId, 'Готово. Куда отправить?', {
    reply_markup: { inline_keyboard: [[sendToChatButton(entry)]] },
  })
}

async function handleVoice(msg, audio) {
  const chatId = msg.chat.id
  const userId = msg.from?.id
  const status = await tg
    .sendMessage(chatId, '🎧 Слушаю…', { reply_to_message_id: msg.message_id })
    .catch(() => null)

  try {
    const file = await tg.downloadFile(audio.fileId)
    const mime = audio.mime || guessMimeByPath(file.path)
    const { text } = await speechToText(file.buffer, { mime, style: config.defaultStyle })

    if (!text) {
      await tg.sendMessage(chatId, 'Не разобрал ни слова — попробуйте ещё раз.')
      return
    }

    const entry = store.remember(userId, text)
    const parts = chunk(text)
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1
      await tg.sendMessage(chatId, parts[i], {
        ...(isLast ? { reply_markup: { inline_keyboard: [[sendToChatButton(entry)]] } } : {}),
      })
    }
  } catch (err) {
    console.error('[voice]', err)
    await tg.sendMessage(chatId, 'Не получилось распознать: ' + err.message).catch(() => {})
  } finally {
    if (status) {
      await tg.call('deleteMessage', { chat_id: chatId, message_id: status.message_id }).catch(() => {})
    }
  }
}

function guessMimeByPath(path = '') {
  const ext = path.split('.').pop()?.toLowerCase()
  return (
    {
      oga: 'audio/ogg',
      ogg: 'audio/ogg',
      mp3: 'audio/mpeg',
      m4a: 'audio/m4a',
      mp4: 'audio/mp4',
      wav: 'audio/wav',
      webm: 'audio/webm',
    }[ext] || 'audio/ogg'
  )
}

// ── маршрутизация апдейтов ──────────────────────────────────────────────────

export async function handleUpdate(update) {
  try {
    if (update.inline_query) return await onInlineQuery(update.inline_query)
    if (update.message) return await onMessage(update.message)
  } catch (err) {
    console.error('[update]', err)
  }
}

/** Разовая настройка бота при старте. */
export async function bootstrap() {
  const info = await me()
  console.log(`[bot] @${info.username} (${info.id})`)

  await tg
    .call('setMyCommands', {
      commands: [{ command: 'start', description: 'Как говорить голосом в любом чате' }],
    })
    .catch((e) => console.warn('[bot] setMyCommands:', e.message))

  // Кнопка «Голос» рядом со скрепкой в личке с ботом.
  await tg
    .call('setChatMenuButton', {
      menu_button: { type: 'web_app', text: 'Говорить', web_app: { url: config.miniAppUrl } },
    })
    .catch((e) => console.warn('[bot] setChatMenuButton:', e.message))

  return info
}
