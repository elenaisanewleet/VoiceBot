/**
 * Переходник для бессерверных площадок (Vercel и подобные).
 *
 * Там нет постоянно работающего процесса — каждый запрос поднимает функцию.
 * Логика при этом ровно та же, что и у обычного сервера: Vercel отдаёт функции
 * привычные Node-объекты запроса и ответа, поэтому достаточно передать их в тот
 * же обработчик. Файл называется [...path], чтобы ловить все пути под /api.
 *
 * Mini App при этом раздаётся площадкой напрямую из public/ — функция для
 * статики не будится.
 */
import { handleRequest } from '../src/server.js'

export default async function handler(req, res) {
  try {
    await handleRequest(req, res)
  } catch (err) {
    console.error('[api]', err)
    if (!res.headersSent) {
      res.statusCode = err.status || 500
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: err.message }))
    } else {
      res.end()
    }
  }
}
