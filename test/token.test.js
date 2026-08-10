import test from 'node:test'
import assert from 'node:assert/strict'

import { mintToken, verifyToken } from '../src/token.js'

const SECRET = 'секрет-для-теста'

test('свежий пропуск проходит и называет владельца', () => {
  const pass = verifyToken(mintToken(4242, SECRET), SECRET)
  assert.equal(pass.ok, true)
  assert.equal(pass.userId, 4242)
})

test('пропуск, выписанный на другом секрете, не проходит', () => {
  const pass = verifyToken(mintToken(1, 'чужой секрет'), SECRET)
  assert.equal(pass.ok, false)
  assert.match(pass.reason, /подделан/)
})

test('подмена содержимого ломает подпись', () => {
  const [, sig] = mintToken(1, SECRET).split('.')
  const forged = Buffer.from(
    JSON.stringify({ u: 999, e: Math.floor(Date.now() / 1000) + 60 }),
  ).toString('base64url')
  const pass = verifyToken(`${forged}.${sig}`, SECRET)
  assert.equal(pass.ok, false)
  assert.match(pass.reason, /подделан/)
})

test('просроченный пропуск не проходит и объясняет, что делать', () => {
  const pass = verifyToken(mintToken(1, SECRET, -1), SECRET)
  assert.equal(pass.ok, false)
  assert.match(pass.reason, /просрочен/)
})

test('пустой или обрезанный пропуск не проходит', () => {
  for (const bad of ['', 'без-точки', null, undefined]) {
    assert.equal(verifyToken(bad, SECRET).ok, false)
  }
})
