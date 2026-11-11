import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('./nostr', () => ({ getNostrRuntime: () => ({ query: queryMock }), PUBLIC_PROFILE_RELAYS: [] }))

import { createProfileStore } from './profile'

const ALICE = 'a'.repeat(64)
const BOB = 'b'.repeat(64)
const CAROL = 'c'.repeat(64)
const timedOut = { events: [], complete: false, reason: 'timeout' }
const found = (pubkey: string, name: string) => ({
  events: [{ pubkey, created_at: 10, content: JSON.stringify({ name }) }], complete: true, reason: 'eose',
})

describe('profile store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    queryMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks again when a lookup ran out of time, and shows the name once it is there', async () => {
    queryMock.mockResolvedValueOnce(timedOut).mockResolvedValueOnce(found(ALICE, 'Alice'))
    const seen: Array<string | undefined> = []
    const unsubscribe = createProfileStore(ALICE).subscribe((profile) => seen.push(profile?.name))
    await vi.advanceTimersByTimeAsync(0)
    expect(queryMock).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([undefined])

    await vi.advanceTimersByTimeAsync(5000)
    expect(queryMock).toHaveBeenCalledTimes(2)
    expect(seen).toEqual([undefined, 'Alice'])

    await vi.advanceTimersByTimeAsync(120000)
    expect(queryMock).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('believes relays that finished without a profile, and gives up on silence after a few tries', async () => {
    queryMock.mockResolvedValue({ events: [], complete: true, reason: 'eose' })
    const settled = createProfileStore(BOB)
    const stopSettled = settled.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(120000)
    expect(queryMock).toHaveBeenCalledTimes(1)
    stopSettled()

    queryMock.mockReset()
    queryMock.mockResolvedValue(timedOut)
    const silent = createProfileStore(CAROL)
    const stopSilent = silent.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(300000)
    expect(queryMock).toHaveBeenCalledTimes(4)
    stopSilent()
  })

  it('stops asking once nobody is showing the person', async () => {
    const DAVE = 'd'.repeat(64)
    queryMock.mockResolvedValue(timedOut)
    const stop = createProfileStore(DAVE).subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    stop()
    await vi.advanceTimersByTimeAsync(120000)
    expect(queryMock).toHaveBeenCalledTimes(1)
  })
})
