import { describe, expect, it, vi, afterEach } from 'vitest'
import { MeetingTransport, type MeetingEndpoint } from './meetingTransport'
import { encodeCallMedia } from './callProtocol'

const room = 'ab'.repeat(16)
const alice = `02${'11'.repeat(32)}`
const bob = `03${'22'.repeat(32)}`

function network() {
  const handlers = new Map<string, (packet: { src: string; payload: Uint8Array }) => void>()
  const sent: Uint8Array[] = []
  let drop = false
  const endpoint = (self: string): MeetingEndpoint => ({
    registerService(_port, handler) { handlers.set(self.slice(2), handler); return () => { handlers.delete(self.slice(2)) } },
    async sendDatagram({ dst, payload }) {
      sent.push(payload)
      if (!drop) handlers.get(dst.slice(2))?.({ src: self, payload })
    },
  })
  return { endpoint, sent, drop: (value: boolean) => { drop = value } }
}

afterEach(() => vi.useRealTimers())

describe('authenticated meeting transport', () => {
  it('reports complete video delivery and includes partially lost frames in feedback', async () => {
    vi.useFakeTimers()
    const net = network(), bitrate = vi.fn()
    const a = new MeetingTransport(net.endpoint(alice), room, { bitrate })
    const b = new MeetingTransport(net.endpoint(bob), room, {})
    a.addPeer(bob); b.addPeer(alice)
    a.setState({ audioEnabled: true, videoEnabled: true, screenSharing: false })
    const frame = { kind: 2 as const, key: true, seq: 300, timestamp: 1000, bytes: new Uint8Array(4000).fill(42) }
    await a.sendMedia(frame)
    // The next frame is only partially delivered; feedback must still count it as expected.
    const fragments = encodeCallMedia(room, { ...frame, seq: 301 })
    await net.endpoint(alice).sendDatagram({ dst: bob, srcPort: 39512, dstPort: 39512, payload: fragments[0] })
    await vi.advanceTimersByTimeAsync(1000)
    const reports = net.sent.filter(p => p[0] !== 73).map(p => JSON.parse(new TextDecoder().decode(p))).filter(p => p.type === 'feedback')
    expect(reports).toContainEqual(expect.objectContaining({ video_seq: 301, received_frames: 1, received_bytes: 4000, interval_ms: 1000 }))
    // After late-join calibration, only one incomplete frame is tolerated, not 300 invented losses.
    expect(a.videoBitrate).toBeGreaterThanOrEqual(1200000)
    await a.close(); await b.close()
  })
  it('adapts group video to the slow receiver and recovers when that receiver leaves', async () => {
    vi.useFakeTimers()
    const net = network(), carol = `02${'33'.repeat(32)}`
    const a = new MeetingTransport(net.endpoint(alice), room, {})
    const b = new MeetingTransport(net.endpoint(bob), room, {})
    const c = new MeetingTransport(net.endpoint(carol), room, {})
    a.addPeer(bob); a.addPeer(carol); b.addPeer(alice); c.addPeer(alice)
    a.setState({ audioEnabled: false, videoEnabled: true, screenSharing: false })
    const report = (self: string, count: number) => net.endpoint(self).sendDatagram({
      dst: alice, srcPort: 39512, dstPort: 39512,
      payload: new TextEncoder().encode(JSON.stringify({ v: 1, room, type: 'feedback', feedback_seq: 0, video_seq: 29, received_frames: count, received_bytes: 50000, interval_ms: 1000 })),
    })
    await a.sendMedia({ kind: 2, key: true, seq: 0, timestamp: 1000, bytes: new Uint8Array(100) })
    await report(carol, 30)
    const healthy = a.videoBitrate
    await report(bob, 20)
    expect(a.videoBitrate).toBe(340000)
    a.removePeer(bob)
    expect(a.videoBitrate).toBeGreaterThanOrEqual(healthy)
    a.setState({ audioEnabled: false, videoEnabled: false, screenSharing: false })
    const paused = a.videoBitrate
    await vi.advanceTimersByTimeAsync(10000)
    expect(a.videoBitrate).toBe(paused)
    await a.close(); await b.close(); await c.close()
  })
  it('finishes leaving even when the last route is unavailable', async () => {
    vi.useFakeTimers()
    const a = new MeetingTransport({
      registerService: () => () => {},
      sendDatagram: () => new Promise(() => {}),
    }, room, {})
    a.addPeer(bob)
    let closed = false
    void a.close().then(() => { closed = true })
    await vi.advanceTimersByTimeAsync(500)
    expect(closed).toBe(true)
  })
  it('reports a missing route and recovers when the peer responds', async () => {
    vi.useFakeTimers()
    const net = network(), failed = vi.fn(), connected = vi.fn()
    const a = new MeetingTransport(net.endpoint(alice), room, { failed, connected })
    a.addPeer(bob)
    await vi.advanceTimersByTimeAsync(16000)
    expect(failed).toHaveBeenCalledWith(`02${bob.slice(2)}`)
    const b = new MeetingTransport(net.endpoint(bob), room, {})
    b.addPeer(alice)
    await vi.advanceTimersByTimeAsync(1000)
    expect(connected).toHaveBeenCalledWith(`02${bob.slice(2)}`)
    await a.close(); await b.close()
  })
  it('admits only discovered identities and binds messages to the authenticated sender', async () => {
    const net = network(), received = vi.fn()
    const a = new MeetingTransport(net.endpoint(alice), room, { message: received })
    const b = new MeetingTransport(net.endpoint(bob), room, {})
    b.addPeer(alice)
    b.chat('hello')
    await Promise.resolve()
    expect(received).not.toHaveBeenCalled()
    a.addPeer(`02${bob.slice(2)}`)
    b.chat('authenticated')
    await Promise.resolve()
    expect(received).toHaveBeenCalledWith(`02${bob.slice(2)}`, expect.objectContaining({ text: 'authenticated' }))
    a.close(); b.close()
  })

  it('retries a lost chat packet and delivers it only once', async () => {
    vi.useFakeTimers()
    const net = network(), received = vi.fn()
    const a = new MeetingTransport(net.endpoint(alice), room, {})
    const b = new MeetingTransport(net.endpoint(bob), room, { message: received })
    a.addPeer(bob); b.addPeer(alice)
    net.drop(true)
    a.chat('retry me')
    await vi.advanceTimersByTimeAsync(1000)
    expect(received).not.toHaveBeenCalled()
    net.drop(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(received).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(received).toHaveBeenCalledTimes(1)
    a.close(); b.close()
  })

  it('rejects other rooms and stops sending after leave', async () => {
    vi.useFakeTimers()
    const net = network(), received = vi.fn()
    const a = new MeetingTransport(net.endpoint(alice), room, {})
    const b = new MeetingTransport(net.endpoint(bob), 'cd'.repeat(16), { message: received, connected: received })
    a.addPeer(bob); b.addPeer(alice)
    a.chat('wrong room')
    await vi.advanceTimersByTimeAsync(2000)
    expect(received).not.toHaveBeenCalled()
    a.close(); b.close()
    const count = net.sent.length
    await vi.advanceTimersByTimeAsync(20000)
    expect(net.sent).toHaveLength(count)
  })

  it('reassembles media per sender and rejects fragments from undiscovered peers', async () => {
    const net = network(), media = vi.fn()
    const a = new MeetingTransport(net.endpoint(alice), room, {})
    const b = new MeetingTransport(net.endpoint(bob), room, { media })
    a.addPeer(bob)
    const frame = { kind: 2 as const, key: true, seq: 0, timestamp: 1000, bytes: new Uint8Array(4000).fill(42) }
    await a.sendMedia(frame)
    expect(media).not.toHaveBeenCalled()
    expect(net.sent.filter(packet => packet[0] === 73)).toHaveLength(0)
    b.addPeer(alice)
    await a.sendMedia(frame)
    expect(media).toHaveBeenCalledWith(alice, frame)
    a.close(); b.close()
  })

  it('keeps sending to responsive participants while another route stalls', async () => {
    const net = network(), media = vi.fn(), carol = `02${'33'.repeat(32)}`
    const endpoint = net.endpoint(alice)
    let unblock!: () => void
    const blocked = new Promise<void>(resolve => { unblock = resolve })
    const a = new MeetingTransport({
      ...endpoint,
      sendDatagram: packet => packet.dst === `02${bob.slice(2)}` && packet.payload[0] === 73
        ? blocked : endpoint.sendDatagram(packet),
    }, room, {})
    const c = new MeetingTransport(net.endpoint(carol), room, { media })
    const b = new MeetingTransport(net.endpoint(bob), room, {})
    a.addPeer(bob); b.addPeer(alice); a.addPeer(carol); c.addPeer(alice)
    const frame = { kind: 2 as const, key: true, seq: 0, timestamp: 1000, bytes: new Uint8Array(100).fill(42) }
    const first = a.sendMedia(frame)
    await Promise.resolve()
    await a.sendMedia({ ...frame, seq: 1 })
    expect(media).toHaveBeenCalledTimes(2)
    unblock(); await first
    await a.close(); await b.close(); await c.close()
  })
})
