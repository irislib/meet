import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

const events = new Map()
const interests = new Map()
const server = createServer((_request, response) => response.end('ready'))
const sockets = new WebSocketServer({ server, maxPayload: 1024 * 1024 })
const matches = (event, filter) => Object.entries(filter).every(([key, value]) => {
  if (key === 'since') return event.created_at >= value
  if (key === 'until') return event.created_at <= value
  if (!Array.isArray(value)) return true
  if (key === 'kinds') return value.includes(event.kind)
  if (key === 'authors') return value.includes(event.pubkey)
  if (key === 'ids') return value.includes(event.id)
  if (key.startsWith('#')) return event.tags.some(tag => tag[0] === key.slice(1) && value.includes(tag[1]))
  return true
})
const send = (socket, message) => { if (socket.readyState === 1) socket.send(JSON.stringify(message)) }
sockets.on('connection', (socket, request) => {
  // One configured relay accepts a socket but never responds. Calls must use
  // the healthy relay without waiting for this one's history or publish ACK.
  if (request.url === '/unresponsive') return
  interests.set(socket, new Map())
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString())
    if (message[0] === 'REQ') {
      const filters = message.slice(2)
      const subscribe = () => {
        if (!interests.has(socket)) return
        interests.get(socket).set(message[1], filters)
        for (const event of events.values()) if (filters.some(filter => matches(event, filter))) send(socket, ['EVENT', message[1], event])
        send(socket, ['EOSE', message[1]])
      }
      // Exercise publication racing a batched interest: an early presence
      // reply must not be the only opportunity for newcomers to find peers.
      if (filters.some(filter => filter.kinds?.includes(25050))) setTimeout(subscribe, 50)
      else subscribe()
    } else if (message[0] === 'EVENT') {
      const event = message[1]
      if (event.kind < 20000 || event.kind >= 30000) events.set(event.id, event)
      for (const [peer, subscriptions] of interests) for (const [id, filters] of subscriptions) {
        if (filters.some(filter => matches(event, filter))) send(peer, ['EVENT', id, event])
      }
      send(socket, ['OK', event.id, true, ''])
    } else if (message[0] === 'CLOSE') interests.get(socket).delete(message[1])
  })
  socket.on('close', () => interests.delete(socket))
})
server.listen(Number(process.env.PW_RELAY_PORT ?? 49319), '127.0.0.1')
