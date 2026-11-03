import { DexieStore } from '@hashtree/dexie'
import { getNostrRuntime } from '../../src/lib/nostr'
import legacy from './legacy-event-index.json'

const storeName = 'iris-meet-events'

function fromHex(hex: string) {
  return Uint8Array.from(hex.match(/../g)!, pair => parseInt(pair, 16))
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function seedLegacyIndex() {
  // Let the production adapter initialize its own IndexedDB schema.
  await getNostrRuntime().query([{ ids: [legacy.id] }], { cache: 'cache-only' })
  const blocks = new DexieStore(storeName)
  try {
    for (const [hash, data] of Object.entries(legacy.blocks)) {
      await blocks.put(fromHex(hash), Uint8Array.from(atob(data), c => c.charCodeAt(0)))
    }
  } finally { blocks.close() }
  const db = await result(indexedDB.open(storeName + '-nostr-index'))
  try {
    const state = db.transaction('state', 'readwrite').objectStore('state')
    await result(state.put({ id: 'roots', value: {
      root: { hash: fromHex(legacy.root.hash), key: fromHex(legacy.root.key) },
      outboxRoot: null, pending: [],
    } }))
  } finally { db.close() }
}

export async function rootKey() {
  const db = await result(indexedDB.open(storeName + '-nostr-index'))
  try {
    const row = await result(db.transaction('state').objectStore('state').get('roots'))
    return Array.from(row.value.root.key as Uint8Array)
  } finally { db.close() }
}

export async function cachedIds(ids: string[]) {
  const result = await getNostrRuntime().query([{ ids }], { cache: 'cache-only' })
  return result.events.map(event => event.id).sort()
}
