import test from 'node:test'
import assert from 'node:assert/strict'
import { translationTargetForMessage } from '../src/translation-routing.js'

const privateMessage = (text, extras = {}) => ({ chat: { type: 'private' }, text, ...extras })

test('forwarded Russian messages route to Chinese', () => {
  const message = privateMessage('Привет! Как дела?', { forward_origin: { type: 'user', sender_user: { id: 1 } } })
  assert.equal(translationTargetForMessage(message), 'zh')
})

test('forwarded Russian messages from hidden senders still translate', () => {
  const message = privateMessage('До завтра!', { forward_origin: { type: 'hidden_user', sender_user_name: 'Friend' } })
  assert.equal(translationTargetForMessage(message), 'zh')
})

test('non-forwarded Russian messages preserve original inline-draft behavior', () => {
  assert.equal(translationTargetForMessage(privateMessage('Привет, напиши мне!')), null)
})

test('Chinese content routes to Russian, forwarded or not', () => {
  assert.equal(translationTargetForMessage(privateMessage('你好！')), 'ru')
  assert.equal(translationTargetForMessage(privateMessage('你好吗', { forward_date: 1690000000 })), 'ru')
})

test('commands, groups, empty text, latin-only forwards are not translated', () => {
  assert.equal(translationTargetForMessage(privateMessage('/start', { forward_date: 1690000000 })), null)
  assert.equal(translationTargetForMessage({ chat: { type: 'group' }, text: '你好' }), null)
  assert.equal(translationTargetForMessage(privateMessage('', { forward_date: 1690000000 })), null)
  assert.equal(translationTargetForMessage(privateMessage('Hello', { forward_date: 1690000000 })), null)
})
