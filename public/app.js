/**
 * Mini App: микрофон → грамотный текст → сообщение в тот же чат.
 *
 * Почему именно так:
 *  • Telegram-бот не имеет доступа к микрофону — доступ есть только у веб-страницы
 *    внутри Telegram, то есть у Mini App.
 *  • Окно открывается кнопкой из панели (@бот в любом чате) прямо поверх этого
 *    чата. Данных запуска Telegram такому окну не передаёт, поэтому пропуск
 *    выписывает наш сервер при ответе на inline-запрос и вшивает в адрес.
 *  • Готовый текст возвращается в тот же чат через switchInlineQuery — это
 *    штатный способ вернуться из окна обратно в переписку. Уходит обычным
 *    текстовым сообщением от имени пользователя, без голосовых.
 *  • Второй способ отправки — буфер обмена. Он единственный без пометки
 *    «с помощью бота»: её Telegram ставит на всё, что ушло через строку с
 *    именем бота, и отключить её нельзя.
 *  • Настольные клиенты дают микрофон не всегда: там страница живёт в системном
 *    движке или во фрейме веб-версии. Если не дали — предлагаем открыть эту же
 *    страницу в браузере: пропуск вшит в адрес, значит она там полноценна.
 */

const tg = window.Telegram?.WebApp

const el = {
  status: document.getElementById('status'),
  mic: document.getElementById('mic'),
  miclabel: document.getElementById('miclabel'),
  ring: document.getElementById('ring'),
  text: document.getElementById('text'),
  hint: document.getElementById('hint'),
  clear: document.getElementById('clear'),
  copy: document.getElementById('copy'),
  browser: document.getElementById('browser'),
  styles: document.getElementById('styles'),
  lang: document.getElementById('lang'),
  error: document.getElementById('error'),
}

// ── где мы открыты ──────────────────────────────────────────────────────────
// Библиотека Telegram грузится на любой странице и вне Telegram подставляет
// площадку «unknown» — по ней и отличаем окно внутри мессенджера от вкладки
// обычного браузера, куда мы сами же можем себя отправить (см. openInBrowser).

const PLATFORM = tg?.platform || 'unknown'
const INSIDE_TELEGRAM = PLATFORM !== 'unknown'
const MOBILE = PLATFORM === 'ios' || PLATFORM === 'android'

// ── настройки ───────────────────────────────────────────────────────────────

const DEFAULTS = { style: 'clean', lang: 'ru' }
const SETTINGS_KEY = '139bot.settings'

const settings = (() => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }
  } catch {
    return { ...DEFAULTS }
  }
})()

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    /* приватный режим — переживём */
  }
}

// ── состояние ───────────────────────────────────────────────────────────────

// Эта страница — не сайт: кто вы и в какой чат отправлять, сообщает сам
// Telegram при открытии. В обычном браузере таких данных нет и быть не может,
// поэтому объясняем, как открыть правильно, вместо «попробуйте ещё раз».
const OUTSIDE_TELEGRAM =
  'Эта страница работает только внутри Telegram. Наберите имя бота в любом ' +
  'чате и нажмите кнопку «🎙 Говорить» — окно откроется само.'

/**
 * Признаки того, как открыли страницу. Снаружи Telegram библиотека всё равно
 * загружается и подставляет площадку «unknown» — по ней и видно разницу между
 * «открыли в браузере» и «что-то сломалось внутри Telegram».
 */
function describeLaunch() {
  const platform = window.Telegram?.WebApp?.platform || 'нет'
  const version = window.Telegram?.WebApp?.version || '—'
  const chat = new URLSearchParams(window.Telegram?.WebApp?.initData || '').get('query_id')
  return `площадка: ${platform}, версия: ${version}, чат назначения: ${chat ? 'есть' : 'нет'}`
}

const state = {
  recording: false,
  starting: false,
  busy: false,
  pending: 0, // сколько кусков ещё распознаётся
  sending: false,
}

// ── мелкие утилиты ──────────────────────────────────────────────────────────

const haptic = (kind = 'impact', style = 'medium') => {
  try {
    if (kind === 'impact') tg?.HapticFeedback?.impactOccurred(style)
    else tg?.HapticFeedback?.notificationOccurred(style)
  } catch {
    /* не критично */
  }
}

function showError(message) {
  el.error.textContent = message
  el.error.hidden = !message
}

function setStatus(text, live = false) {
  el.status.textContent = text
  el.status.classList.toggle('is-live', live)
}

function setHint(text, working = false) {
  el.hint.textContent = text
  el.hint.classList.toggle('is-working', working)
}

/** Подпись под кнопкой: что произойдёт от нажатия прямо сейчас. */
function setMicLabel(text, live = false) {
  el.miclabel.textContent = text
  el.miclabel.classList.toggle('is-live', live)
}

const IDLE_LABEL = 'Нажмите, чтобы говорить'

// Таймер под кнопкой — самое наглядное доказательство, что запись идёт и что
// закончить её нужно этой же кнопкой.
let clockTimer = null

function startClock() {
  const started = Date.now()
  const paint = () => {
    const s = Math.round((Date.now() - started) / 1000)
    const mmss = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
    setMicLabel(`Идёт запись · ${mmss} — нажмите, чтобы закончить`, true)
  }
  paint()
  clockTimer = setInterval(paint, 1000)
}

function stopClock() {
  clearInterval(clockTimer)
  clockTimer = null
}

const MAX_LEN = 4096

function currentText() {
  return el.text.value.trim()
}

function syncMainButton() {
  if (!tg?.MainButton) return
  const text = currentText()
  if (text && !state.recording) {
    tg.MainButton.setText(state.sending ? 'Готовлю…' : 'Вставить в чат')
    tg.MainButton.show()
    if (state.sending || state.busy) tg.MainButton.disable()
    else tg.MainButton.enable()
  } else {
    tg.MainButton.hide()
  }
  if (text.length > MAX_LEN) {
    showError(`Слишком длинно: ${text.length} из ${MAX_LEN} символов. Отправится первая часть.`)
  }
}

function appendPhrase(phrase) {
  if (!phrase) return
  const existing = el.text.value
  const needsSpace = existing && !/\s$/.test(existing)
  el.text.value = existing + (needsSpace ? ' ' : '') + phrase
  el.text.scrollTop = el.text.scrollHeight
  syncMainButton()
}

// ── сеть ────────────────────────────────────────────────────────────────────

const initData = tg?.initData || ''

// Пропуск, вшитый в адрес кнопки. Нужен, когда окно открыто из панели в чужом
// чате: там Telegram данных запуска не передаёт, и подтвердить, кто пришёл,
// больше нечем.
const appToken = new URLSearchParams(location.search).get('t') || ''

/** Есть чем подтвердить, кто пришёл. */
const authorized = () => Boolean(initData || appToken)

async function api(path, { body, headers = {}, raw = false } = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: raw
      ? { 'x-init-data': initData, 'x-app-token': appToken, ...headers }
      : { 'content-type': 'application/json' },
    body: raw ? body : JSON.stringify({ initData, token: appToken, ...body }),
  })
  const data = await res.json().catch(() => ({}))
  // Причина всегда конкретнее общего кода ошибки — показываем её.
  if (!res.ok) throw new Error(data.reason || data.error || `HTTP ${res.status}`)
  return data
}

const transcribeSegment = (blob) =>
  api(`/api/stt?lang=${encodeURIComponent(settings.lang)}&style=raw`, {
    raw: true,
    body: blob,
    headers: { 'content-type': blob.type || 'audio/webm' },
  })

// ── упорядоченная очередь распознанных кусков ───────────────────────────────
// Куски уезжают на распознавание параллельно и могут вернуться вразнобой,
// поэтому вставляем их в текст строго в порядке произнесения.

const queue = { next: 0, ready: new Map() }

function deliver(index, text) {
  if (index < queue.next) return // кусок от очищенной сессии — выбрасываем
  queue.ready.set(index, text)
  while (queue.ready.has(queue.next)) {
    appendPhrase(queue.ready.get(queue.next))
    queue.ready.delete(queue.next)
    queue.next++
  }
}

// ── запись с определением пауз ──────────────────────────────────────────────

const SILENCE_MS = 700 // столько тишины считаем концом фразы
const MIN_SPEECH_MS = 350 // короче — это кашель, а не фраза
const MAX_SEGMENT_MS = 7000 // длинный монолог режем, чтобы текст шёл на глазах
const IDLE_RESTART_MS = 10_000 // молчим — не копим пустой файл

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/aac',
]

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null
  for (const mime of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported?.(mime)) return mime
  }
  return ''
}

const rec = {
  stream: null,
  ctx: null,
  analyser: null,
  buffer: null,
  recorder: null,
  chunks: [],
  timer: null,
  mime: null,
  segmentIndex: 0,
  segmentStart: 0,
  speechMs: 0,
  lastVoiceAt: 0,
  floor: 0.006,
  calibrateUntil: 0,
}

// ── микрофон: почему клиент может его не дать ───────────────────────────────
// На телефоне окно записи — это webview внутри Telegram, и разрешение спрашивает
// сам Telegram. В настольных клиентах страница живёт в системном движке
// (WKWebView на macOS, WebView2 на Windows) или во фрейме веб-версии — там доступ
// решают система и политика фрейма, и отказ приходит таким же глухим
// NotAllowedError. Поэтому проверяем заранее, объясняем по-разному и всегда
// оставляем запасной выход: та же страница с тем же пропуском открывается в
// обычном браузере, где микрофон точно есть.

function micUnavailableReason() {
  if (!window.isSecureContext) return 'Страница открыта не по https — микрофон браузер не даст.'
  if (!navigator.mediaDevices?.getUserMedia) return 'Этот клиент не пускает страницу к микрофону.'
  if (document.featurePolicy?.allowsFeature?.('microphone') === false) {
    return 'Клиент открыл окно без разрешения на микрофон.'
  }
  if (pickMime() === null) return 'Этот клиент не умеет записывать звук со страницы.'
  return null
}

function micPermissionHelp() {
  if (MOBILE) {
    return 'Разрешите Telegram доступ к микрофону в настройках телефона и откройте окно заново.'
  }
  if (PLATFORM === 'macos' || PLATFORM === 'tdesktop') {
    return (
      'Разрешите микрофон самому приложению Telegram: macOS — Системные настройки → ' +
      'Конфиденциальность и безопасность → Микрофон; Windows — Параметры → ' +
      'Конфиденциальность → Микрофон. Затем откройте окно заново.'
    )
  }
  return 'Разрешите доступ к микрофону для этой страницы в настройках браузера.'
}

/** Адрес этой же страницы для внешнего браузера — с пропуском, но без хвоста Telegram. */
const browserUrl = () =>
  location.origin + location.pathname + (appToken ? `?t=${encodeURIComponent(appToken)}` : '')

/** Пропуск живёт час и вшит в адрес, так что в браузере страница полноценна. */
function offerBrowser(show) {
  el.browser.hidden = !(show && INSIDE_TELEGRAM && Boolean(appToken))
}

async function startRecording() {
  if (state.recording || state.starting) return
  // Без данных запуска отправлять всё равно некуда, а записанное пропадёт зря.
  // Проверяем до очистки ошибки, иначе объяснение исчезнет с экрана.
  if (!authorized()) return showError(`${OUTSIDE_TELEGRAM}\n(${describeLaunch()})`)
  showError('')
  offerBrowser(false)

  const blocked = micUnavailableReason()
  if (blocked) {
    showError(
      `${blocked}\n${micPermissionHelp()}\n` +
        'Либо пришлите голосовое в чат с ботом — расшифрую и верну текстом.',
    )
    offerBrowser(true)
    return
  }

  // Разрешение спрашивается асинхронно — до ответа кнопка не должна повторно стрелять.
  state.starting = true
  el.mic.classList.add('is-busy')
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
  } catch (err) {
    const denied = err.name === 'NotAllowedError' || err.name === 'SecurityError'
    showError(
      denied
        ? `Микрофон запрещён. ${micPermissionHelp()}`
        : err.name === 'NotFoundError'
          ? 'Микрофон не найден — проверьте, что он подключён и выбран в системе.'
          : 'Микрофон недоступен: ' + err.message,
    )
    offerBrowser(true)
    return
  } finally {
    state.starting = false
    el.mic.classList.remove('is-busy')
  }

  const mime = pickMime()

  rec.mime = mime
  const Ctx = window.AudioContext || window.webkitAudioContext
  rec.ctx = new Ctx()
  if (rec.ctx.state === 'suspended') await rec.ctx.resume()
  rec.analyser = rec.ctx.createAnalyser()
  rec.analyser.fftSize = 1024
  rec.buffer = new Uint8Array(rec.analyser.fftSize)
  rec.ctx.createMediaStreamSource(rec.stream).connect(rec.analyser)

  rec.floor = 0.006
  rec.calibrateUntil = performance.now() + 500
  state.recording = true

  el.mic.classList.add('is-recording')
  el.mic.setAttribute('aria-label', 'Закончить запись')
  setStatus('Слушаю — говорите', true)
  startClock()
  setHint('')
  haptic('impact', 'medium')
  tg?.enableClosingConfirmation?.()
  syncMainButton()

  startSegment()
  rec.timer = setInterval(tick, 50)
}

function startSegment() {
  rec.chunks = []
  rec.speechMs = 0
  rec.segmentStart = performance.now()
  rec.lastVoiceAt = 0

  try {
    rec.recorder = rec.mime
      ? new MediaRecorder(rec.stream, { mimeType: rec.mime })
      : new MediaRecorder(rec.stream)
  } catch {
    rec.recorder = new MediaRecorder(rec.stream)
  }

  const index = rec.segmentIndex++
  const chunks = rec.chunks
  let hadSpeech = false

  // Резолвится, когда браузер отдал последний кусок данных. Без этого
  // «стоп» мог отработать раньше, чем приедет последняя фраза.
  let settle
  rec.segmentDone = new Promise((resolve) => {
    settle = resolve
  })

  rec.recorder.ondataavailable = (e) => e.data?.size && chunks.push(e.data)
  rec.recorder.onstop = () => {
    if (hadSpeech && chunks.length) {
      uploadSegment(index, new Blob(chunks, { type: rec.mime || chunks[0].type }))
    } else {
      deliver(index, '') // держим порядок очереди
    }
    settle()
  }
  rec.recorder.onerror = (e) => {
    console.error('recorder', e)
    deliver(index, '')
    settle()
  }

  // hadSpeech фиксируем в момент остановки — к тому времени tick уже посчитал.
  rec.markSpeech = () => {
    hadSpeech = true
  }
  rec.recorder.start()
}

function cutSegment({ restart = true } = {}) {
  const recorder = rec.recorder
  const done = rec.segmentDone
  rec.recorder = null
  rec.segmentDone = null

  let waiter = Promise.resolve()
  if (recorder && recorder.state !== 'inactive') {
    if (rec.speechMs >= MIN_SPEECH_MS) rec.markSpeech?.()
    recorder.stop()
    waiter = done || waiter
  }

  if (restart && state.recording) startSegment()
  return waiter
}

async function uploadSegment(index, blob) {
  state.pending++
  setHint('распознаю', true)
  syncMainButton()
  try {
    const { raw } = await transcribeSegment(blob)
    deliver(index, (raw || '').trim())
  } catch (err) {
    console.error('stt', err)
    deliver(index, '')
    showError('Кусок не распознался: ' + err.message)
  } finally {
    state.pending--
    if (state.pending === 0) {
      setHint('')
      if (!state.recording) finalize()
    }
    syncMainButton()
  }
}

function tick() {
  const now = performance.now()
  rec.analyser.getByteTimeDomainData(rec.buffer)

  let sum = 0
  for (let i = 0; i < rec.buffer.length; i++) {
    const v = (rec.buffer[i] - 128) / 128
    sum += v * v
  }
  const rms = Math.sqrt(sum / rec.buffer.length)

  // Первые полсекунды слушаем фон, чтобы порог подстроился под комнату.
  if (now < rec.calibrateUntil) {
    rec.floor = Math.min(rec.floor, Math.max(rms, 0.002))
    el.ring.style.transform = 'scale(1)'
    return
  }

  const threshold = Math.max(0.012, rec.floor * 2.5)
  const speaking = rms > threshold

  el.ring.style.transform = `scale(${(1 + Math.min(rms * 5, 0.75)).toFixed(3)})`

  if (speaking) {
    rec.speechMs += 50
    rec.lastVoiceAt = now
  }

  const sinceVoice = rec.lastVoiceAt ? now - rec.lastVoiceAt : now - rec.segmentStart
  const enough = rec.speechMs >= MIN_SPEECH_MS

  if (enough && !speaking && sinceVoice >= SILENCE_MS) {
    cutSegment()
    return
  }
  if (rec.speechMs >= MAX_SEGMENT_MS) {
    cutSegment()
    return
  }
  if (!enough && now - rec.segmentStart >= IDLE_RESTART_MS) {
    cutSegment() // тишина — перезапускаем сегмент, чтобы не копить пустоту
  }
}

async function stopRecording() {
  if (!state.recording) return
  state.recording = false
  clearInterval(rec.timer)
  await cutSegment({ restart: false })

  rec.stream?.getTracks().forEach((t) => t.stop())
  try {
    await rec.ctx?.close()
  } catch {
    /* уже закрыт */
  }
  rec.stream = null
  rec.ctx = null

  stopClock()
  el.mic.classList.remove('is-recording')
  el.mic.setAttribute('aria-label', 'Начать запись')
  el.ring.style.transform = 'scale(1)'
  const said = Boolean(currentText() || state.pending)
  setStatus(said ? 'Готово — проверьте и отправьте' : 'Нажмите и говорите')
  setMicLabel(said ? 'Можно продолжить — нажмите ещё раз' : IDLE_LABEL)
  haptic('impact', 'light')
  tg?.disableClosingConfirmation?.()
  syncMainButton()

  if (state.pending === 0) await finalize()
}

/** Причёсываем накопленный текст один раз — так дешевле и связнее, чем по фразам. */
async function finalize() {
  if (state.busy) return // уже причёсываем — второй раз не надо
  const text = currentText()
  if (!text || settings.style === 'raw') {
    syncMainButton()
    return
  }
  state.busy = true
  setHint('привожу в порядок', true)
  syncMainButton()
  try {
    const { text: polished } = await api('/api/polish', { body: { text, style: settings.style } })
    if (polished && polished !== text) el.text.value = polished
    setHint('готово')
  } catch (err) {
    console.error('polish', err)
    setHint('')
  } finally {
    state.busy = false
    syncMainButton()
  }
}

// ── отправка ────────────────────────────────────────────────────────────────

// Текст возвращается в чат через строку inline-запроса, а она у Telegram
// короткая. Что не влезло — только вручную, для этого есть «Скопировать».
const INLINE_LIMIT = 240

const TOO_LONG_FOR_INLINE =
  'Текст длинный — Telegram не пропустит его через строку запроса. ' +
  'Нажмите «Копировать» и вставьте в чат вручную.'

const PASTE_IT = 'Скопировано — вставьте в поле ввода чата (долгое нажатие → Вставить).'

/**
 * Кладём текст в буфер. Это единственная отправка без пометки «с помощью бота»:
 * всё, что уходит через строку с именем бота, Telegram помечает сам.
 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    /* в части webview буфер закрыт для скрипта — пробуем по-старому */
  }
  try {
    el.text.focus()
    el.text.setSelectionRange(0, el.text.value.length)
    if (document.execCommand?.('copy')) return true
  } catch {
    /* и этого может не быть */
  }
  return false
}

/**
 * Прячем длинный текст на сервере и получаем короткий ключ для строки запроса.
 * Сервер отвечает `id: null`, если хранилище не переживёт соседний запрос, —
 * тогда честнее отправить человека в буфер обмена, чем показать ему `#ключ`.
 */
async function stash(text) {
  try {
    const { id } = await api('/api/stash', { body: { text } })
    return id || null
  } catch (err) {
    console.error('stash', err)
    return null
  }
}

async function send() {
  const text = currentText().slice(0, MAX_LEN)
  if (!text) return

  // Окно открыто в обычном браузере — мы сами себя туда отправили, когда клиент
  // не дал микрофон. Отправлять оттуда некуда, зато буфер обмена работает.
  if (!INSIDE_TELEGRAM) {
    setStatus((await copyText(text)) ? PASTE_IT : 'Скопируйте текст и вставьте в чат.')
    return
  }

  // Длинный текст в строку запроса не влезает: отдаём его серверу и вставляем
  // короткий ключ — бот подставит по нему полный текст, вплоть до 4096.
  let query = text
  if (text.length > INLINE_LIMIT) {
    const id = await stash(text)
    if (!id) return showError(TOO_LONG_FOR_INLINE)
    query = `#${id}`
  }

  // Текст всегда возвращаем через строку ввода — сервер тут не нужен.
  //
  // Раньше отсюда вызывался answerWebAppQuery, но он отправляет «в тот чат,
  // откуда открыли окно». Из чата с ботом это и есть чат с ботом — сообщение
  // уходило не человеку. Годится он только для запуска из inline-режима, а там
  // Telegram как раз не выдаёт query_id. То есть не годится никогда.
  try {
    haptic('impact', 'light')
    if (initData) {
      // Открыто из чата с ботом — куда отправлять, знает только человек.
      tg.switchInlineQuery(query, ['users', 'groups', 'channels'])
    } else {
      // Открыто из панели поверх чужого чата — возвращаемся ровно туда же.
      tg.switchInlineQuery(query)
    }
  } catch (err) {
    // Старый клиент или выключённый inline-режим — путь через буфер остаётся.
    console.error('switchInlineQuery', err)
    showError('Отсюда отправить не вышло. Нажмите «Копировать» и вставьте в поле ввода.')
  }
}

// ── интерфейс ───────────────────────────────────────────────────────────────

el.mic.addEventListener('click', () => {
  if (state.recording) stopRecording()
  else startRecording()
})

el.text.addEventListener('input', syncMainButton)

el.copy.addEventListener('click', async () => {
  const text = currentText()
  if (!text) return
  if (!(await copyText(text))) {
    el.text.focus()
    el.text.select()
    showError('Скопируйте выделенное вручную — здесь буфер обмена закрыт для страницы.')
    return
  }
  haptic('notification', 'success')
  showError('')
  setHint('скопировано')
  // Окно закрываем не сами: человек мог копировать про запас, а несохранённый
  // текст здесь нигде не лежит. Просто говорим, что делать дальше.
  setStatus(PASTE_IT)
})

el.browser.addEventListener('click', () => {
  tg?.openLink?.(browserUrl(), { try_instant_view: false })
})

// На настольном клиенте руки на клавиатуре — привычное сочетание уместнее,
// чем тянуться мышью к кнопке внизу окна.
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    send()
  }
})

el.clear.addEventListener('click', () => {
  el.text.value = ''
  // Куски, уехавшие на распознавание до очистки, уже неактуальны:
  // сдвигаем очередь вперёд, и deliver() их отбросит.
  queue.next = rec.segmentIndex
  queue.ready.clear()
  showError('')
  setHint('')
  setStatus(state.recording ? 'Слушаю — говорите' : 'Нажмите и говорите', state.recording)
  syncMainButton()
})

el.styles.addEventListener('click', (e) => {
  const button = e.target.closest('[data-style]')
  if (!button) return
  settings.style = button.dataset.style
  saveSettings()
  renderSettings()
  haptic('impact', 'light')
})

el.lang.addEventListener('change', () => {
  settings.lang = el.lang.value
  saveSettings()
})

function renderSettings() {
  for (const pill of el.styles.querySelectorAll('[data-style]')) {
    const active = pill.dataset.style === settings.style
    pill.classList.toggle('is-active', active)
    pill.setAttribute('aria-checked', String(active))
  }
  el.lang.value = settings.lang
}

// ── старт ───────────────────────────────────────────────────────────────────

/** Записывать без данных запуска нечего — гасим микрофон, чтобы это было видно. */
function blockRecording() {
  showError(`${OUTSIDE_TELEGRAM}\n(${describeLaunch()})`)
  el.mic.classList.add('is-busy')
  el.mic.setAttribute('aria-disabled', 'true')
  setMicLabel('')
}

function init() {
  renderSettings()
  setMicLabel(IDLE_LABEL)

  // Библиотека Telegram грузится на любой странице, поэтому сам по себе объект
  // ничего не доказывает — судим по данным запуска и по площадке.
  if (!authorized()) {
    blockRecording()
    return
  }

  if (!INSIDE_TELEGRAM) {
    // Вкладка браузера: сюда попадают по кнопке «Открыть в браузере». Кнопки
    // Telegram внизу окна тут нет, поэтому сразу говорим, чем заканчивать.
    setStatus('Наговорите текст и нажмите «Копировать» — вставите в чат сами')
    return
  }

  tg.ready()
  tg.expand?.()
  tg.setHeaderColor?.('secondary_bg_color')
  tg.MainButton.onClick(send)
  tg.onEvent?.('themeChanged', () => {})

  syncMainButton()
}

init()
