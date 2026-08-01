import test from 'node:test'
import assert from 'node:assert/strict'

import { remember, recent, get, _reset } from '../src/store.js'

test('хранит последние фразы пользователя в порядке свежести', () => {
  _reset()
  remember(1, 'первая')
  remember(1, 'вторая')
  const items = recent(1)
  assert.equal(items.length, 2)
  assert.equal(items[0].text, 'вторая')
})

test('не смешивает пользователей', () => {
  _reset()
  const mine = remember(1, 'моё')
  remember(2, 'чужое')
  assert.equal(recent(1).length, 1)
  assert.equal(get(2, mine.id), null)
  assert.equal(get(1, mine.id).text, 'моё')
})

test('держит не больше пяти фраз', () => {
  _reset()
  for (let i = 0; i < 9; i++) remember(1, `фраза ${i}`)
  const items = recent(1)
  assert.equal(items.length, 5)
  assert.equal(items[0].text, 'фраза 8')
})

test('игнорирует пустое', () => {
  _reset()
  assert.equal(remember(1, ''), null)
  assert.equal(remember(null, 'текст'), null)
  assert.equal(recent(1).length, 0)
})

test('выдаёт уникальные идентификаторы', () => {
  _reset()
  const ids = new Set()
  for (let i = 0; i < 5; i++) ids.add(remember(1, `x${i}`).id)
  assert.equal(ids.size, 5)
})
