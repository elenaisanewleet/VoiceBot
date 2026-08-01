import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'

import { verifyInitData } from '../src/initData.js'

const TOKEN = '123456:TEST-TOKEN-abcdef'

function makeInitData(fields, token = TOKEN) {
  const params = new URLSearchParams(fields)
  const checkString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(token).digest()
  const hash = createHmac('sha256', secret).update(checkString).digest('hex')
  params.set('hash', hash)
  return params.toString()
}

const now = () => Math.floor(Date.now() / 1000)

test('принимает корректно подписанный initData', () => {
  const initData = makeInitData({
    auth_date: String(now()),
    query_id: 'AAH123',
    user: JSON.stringify({ id: 42, first_name: 'Тест' }),
  })

  const result = verifyInitData(initData, TOKEN)
  assert.equal(result.ok, true)
  assert.equal(result.userId, 42)
  assert.equal(result.queryId, 'AAH123')
})

test('отклоняет подпись от другого токена', () => {
  const initData = makeInitData({ auth_date: String(now()), user: '{"id":1}' }, '999:OTHER')
  assert.equal(verifyInitData(initData, TOKEN).ok, false)
})

test('отклоняет подменённые данные', () => {
  const initData = makeInitData({
    auth_date: String(now()),
    user: JSON.stringify({ id: 42 }),
  })
  const tampered = initData.replace('%22id%22%3A42', '%22id%22%3A43')
  assert.notEqual(tampered, initData)
  assert.equal(verifyInitData(tampered, TOKEN).ok, false)
})

test('отклоняет initData без hash и пустой', () => {
  assert.equal(verifyInitData('auth_date=1', TOKEN).ok, false)
  assert.equal(verifyInitData('', TOKEN).ok, false)
  assert.equal(verifyInitData(undefined, TOKEN).ok, false)
})

test('отклоняет просроченный initData', () => {
  const initData = makeInitData({ auth_date: String(now() - 48 * 3600), user: '{"id":1}' })
  const result = verifyInitData(initData, TOKEN)
  assert.equal(result.ok, false)
  assert.match(result.reason, /просрочен/)
})

test('не падает на мусоре вместо hash', () => {
  assert.equal(verifyInitData('auth_date=1&hash=нехекс', TOKEN).ok, false)
  assert.equal(verifyInitData('auth_date=1&hash=ab', TOKEN).ok, false)
})

test('игнорирует поле signature при сборке контрольной строки', () => {
  // Telegram кладёт signature для сторонней валидации; в hash оно не входит.
  const base = {
    auth_date: String(now()),
    user: JSON.stringify({ id: 7 }),
  }
  const signed = new URLSearchParams(makeInitData(base))
  signed.set('signature', 'что-угодно')
  assert.equal(verifyInitData(signed.toString(), TOKEN).ok, true)
})
