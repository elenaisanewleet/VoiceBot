/**
 * Telegram bots cannot read ordinary private chats. They only receive content
 * explicitly sent or forwarded to them. Distinguish forwarded Russian texts
 * from ordinary Russian input (which the bot still uses as an inline draft).
 */
export function translationTargetForMessage(message) {
  if (message?.chat?.type !== 'private') return null
  const text = typeof message.text === 'string' ? message.text.trim() : ''
  if (!text || text.startsWith('/')) return null

  // Keep the previous behaviour for Chinese texts (forwarded or pasted).
  if (/[\u3400-\u9fff]/u.test(text)) return 'ru'

  // Only forwarded Russian messages should be translated automatically.
  const forwarded = Boolean(
    message.forward_origin ||
    message.forward_from ||
    message.forward_from_chat ||
    message.forward_sender_name ||
    message.forward_date
  )
  return forwarded && /[\u0400-\u052f]/u.test(text) ? 'zh' : null
}
