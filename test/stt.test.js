import test from 'node:test'
import assert from 'node:assert/strict'

import { extForMime, STYLES, polish } from '../src/stt.js'
import { config } from '../src/config.js'

test('определяет расширение по mime, включая параметры кодека', () => {
  assert.equal(extForMime('audio/webm;codecs=opus'), 'webm')
  assert.equal(extForMime('audio/ogg; codecs=opus'), 'ogg')
  assert.equal(extForMime('audio/mp4'), 'mp4')
  assert.equal(extForMime('AUDIO/WAV'), 'wav')
  assert.equal(extForMime('audio/mpeg'), 'mp3')
})

test('на незнакомом mime не падает, а берёт webm', () => {
  assert.equal(extForMime('application/octet-stream'), 'webm')
  assert.equal(extForMime(''), 'webm')
  assert.equal(extForMime(undefined), 'webm')
})

test('стили ограничены известным списком', () => {
  assert.deepEqual(STYLES, ['raw', 'clean', 'formal'])
})

test('стиль «как сказано» не ходит в сеть и ничего не меняет', async () => {
  config.llm.baseUrl = 'http://127.0.0.1:1' // сюда никто не отвечает
  const said = 'ну э-э привет как дела'
  assert.equal(await polish(said, { style: 'raw' }), said)
})

test('если редактор недоступен — отдаём сказанное как есть, а не теряем', async () => {
  config.llm.baseUrl = 'http://127.0.0.1:1'
  const said = 'ну э-э привет как дела'
  assert.equal(await polish(said, { style: 'clean' }), said)
})

test('пустую расшифровку не отправляем на редактуру', async () => {
  config.llm.baseUrl = 'http://127.0.0.1:1'
  assert.equal(await polish('   ', { style: 'clean' }), '   ')
})
