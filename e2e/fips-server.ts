import { startLocalFipsWebSocketSeed } from './fixtures/localFipsWebSocketSeed.ts'
import { createServer } from 'node:http'

const seed = await startLocalFipsWebSocketSeed(Number(process.env.PW_FIPS_PORT ?? 49320) + 1)
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify({ url: seed.url }))
})
server.listen(Number(process.env.PW_FIPS_PORT ?? 49320), '127.0.0.1')
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  server.close()
  void seed.close().then(() => process.exit())
})
