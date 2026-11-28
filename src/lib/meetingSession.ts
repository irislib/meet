// Meeting state and media use one FIPS node. FIPS owns link negotiation and routing.
import { writable, get } from 'svelte/store'
import { FipsNode, generateIdentity, toHex, type PeerEvent } from '@fips/core'
import { WebRtcTransport } from '@fips/transport-webrtc'
import { WebSocketTransport } from '@fips/transport-websocket'
import { createNostrIdentitySignerFromSecretKey } from '@iris/identity/signers'
import { getProfileDisplayName } from '@iris/svelte-ui/profile'
import { hexToBytes } from 'nostr-tools/utils'
import { getNostrRuntime } from './nostr'
import { identity } from './identity'
import { createMeetingEncryption } from './encryption'
import { addProfileToCache } from './profile'
import { authenticatedMeetingPeer, canonicalPeer, MeetingTransport } from './meetingTransport'
import { MeetingMedia } from './meetingMedia'
import { MEETING_BINDING_KIND, readMeetingPresence } from './meetingPresence'
import { MEETING_PRESENCE_KIND, PRESENCE_PUBLISH_OPTIONS, startMeetingDiscovery } from './meetingDiscovery'
import type { PeerSubscription } from './callSubscriptions'

export type ConnectionState = 'connecting' | 'connected' | 'failed'
export interface Participant {
  pubkey: string
  displayName: string
  stream: MediaStream | null
  fipsPeer: string
  audioEnabled: boolean
  videoEnabled: boolean
  screenSharing: boolean
  connectionState: ConnectionState
}
export interface ChatMessage { id: string; from: string; fromName: string; text: string; timestamp: number }
export interface LocalMedia {
  stream: MediaStream | null; screenStream: MediaStream | null
  audioEnabled: boolean; videoEnabled: boolean; screenSharing: boolean
  audioDeviceId: string | null; videoDeviceId: string | null; audioOutputDeviceId: string | null
}
const emptyMedia = (): LocalMedia => ({ stream: null, screenStream: null, audioEnabled: false, videoEnabled: false, screenSharing: false, audioDeviceId: null, videoDeviceId: null, audioOutputDeviceId: null })
export const participants = writable<Map<string, Participant>>(new Map())
export const localMedia = writable<LocalMedia>(emptyMedia())
export const chatMessages = writable<ChatMessage[]>([])
export const unreadCount = writable(0)
export const focusedPubkey = writable<string | null>(null)
export const meetingError = writable('')
if (typeof window !== 'undefined') participants.subscribe(p => { (window as any).__DEBUG_PARTICIPANTS = p })

const MEDIA_PREFS_KEY = 'iris-meet-media-prefs'
const seeds = import.meta.env.VITE_FIPS_SEEDS?.split(',').filter(Boolean) ?? ['wss://fips2.iris.to/fips', 'wss://fips1.iris.to/fips']
let generation = 0
let active: {
  stopNode: () => Promise<void>; transport: MeetingTransport; media: MeetingMedia
  roomPubkey: string; discovery?: ReturnType<typeof startMeetingDiscovery>
  interval?: ReturnType<typeof setInterval>; presenceTimer?: ReturnType<typeof setTimeout>
  onPageHide?: (event: PageTransitionEvent) => void
  onVisibilityChange?: () => void
  unsubFocus?: () => void
} | undefined

function report(error: unknown) { meetingError.set(error instanceof Error ? error.message : String(error)) }
function findParticipant(map: Map<string, Participant>, peer: string) {
  const canonical = canonicalPeer(peer)
  for (const participant of map.values()) if (participant.fipsPeer === canonical) return participant
  return undefined
}
function updateParticipant(peer: string, patch: Partial<Participant>) {
  const map = get(participants)
  const participant = findParticipant(map, peer)
  if (!participant) return
  let changed = false
  for (const [key, value] of Object.entries(patch) as Array<[keyof Participant, Participant[keyof Participant]]>) {
    if (participant[key] !== value) { changed = true; break }
  }
  if (!changed) return
  Object.assign(participant, patch)
  participants.set(new Map(map))
}
function removeParticipant(peer: string) {
  active?.transport.removePeer(peer); active?.media.removePeer(peer)
  const map = get(participants)
  const removed = findParticipant(map, peer)
  if (removed) {
    const next = new Map(map)
    next.delete(removed.pubkey)
    participants.set(next)
    if (get(focusedPubkey) === removed.pubkey) focusedPubkey.set(null)
  }
  active?.discovery?.refreshPeers()
}
function persistMediaPrefs() {
  if (!active) return
  const { audioEnabled, videoEnabled } = get(localMedia)
  try { localStorage.setItem(MEDIA_PREFS_KEY, JSON.stringify({ meetingId: active.roomPubkey, audioEnabled, videoEnabled })) } catch { /* Storage is optional. */ }
}
export async function restoreMediaPrefsForMeeting(meetingId: string) {
  try {
    const saved = JSON.parse(localStorage.getItem(MEDIA_PREFS_KEY) || 'null')
    if (saved?.meetingId !== meetingId) return
    if (saved.audioEnabled && !get(localMedia).audioEnabled) await toggleAudio()
    if (saved.videoEnabled && !get(localMedia).videoEnabled) await toggleVideo()
  } catch { /* Storage is optional. */ }
}
async function syncMedia() {
  const room = active, media = get(localMedia)
  await room?.media.setCapture(media.stream, media.screenStream, media.audioEnabled, media.videoEnabled)
  if (room !== active) return
  room?.transport.setState({ audioEnabled: media.audioEnabled, videoEnabled: media.videoEnabled, screenSharing: media.screenSharing })
  persistMediaPrefs()
}
const captureConstraints = (kind: 'audio' | 'video', deviceId?: string): MediaStreamConstraints => ({
  [kind]: { ...(kind === 'audio' ? { echoCancellation: true, noiseSuppression: true } : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }), ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
})
const changing = new Set<string>()
async function setDevice(kind: 'audio' | 'video', deviceId?: string): Promise<boolean> {
  if (changing.has(kind)) return false
  changing.add(kind)
  const run = generation
  let acquired: MediaStream | undefined
  let previous: LocalMedia | undefined
  try {
    acquired = await navigator.mediaDevices.getUserMedia(captureConstraints(kind, deviceId))
    if (run !== generation) { acquired.getTracks().forEach(t => t.stop()); return false }
    const track = acquired.getTracks().find(t => t.kind === kind)
    if (!track) throw new Error(`${kind === 'audio' ? 'Microphone' : 'Camera'} unavailable`)
    previous = get(localMedia)
    const tracks = previous.stream?.getTracks().filter(t => t.kind !== kind) ?? []
    const stream = new MediaStream([...tracks, track])
    localMedia.set({ ...previous, stream, [kind === 'audio' ? 'audioEnabled' : 'videoEnabled']: true, [kind === 'audio' ? 'audioDeviceId' : 'videoDeviceId']: track.getSettings().deviceId || null })
    await syncMedia()
    if (run !== generation) { acquired.getTracks().forEach(t => t.stop()); return false }
    previous.stream?.getTracks().filter(t => t.kind === kind).forEach(t => t.stop())
    meetingError.set('')
    return true
  } catch (error) {
    acquired?.getTracks().forEach(t => t.stop())
    if (run === generation) {
      if (previous) { localMedia.set(previous); await syncMedia().catch(() => {}) }
      report(error)
    }
    return false
  } finally { changing.delete(kind) }
}
async function toggle(kind: 'audio' | 'video') {
  const media = get(localMedia), key = kind === 'audio' ? 'audioEnabled' : 'videoEnabled'
  const tracks = media.stream?.getTracks().filter(t => t.kind === kind && t.readyState === 'live') ?? []
  if (!tracks.length) return setDevice(kind)
  const enabled = !media[key]
  tracks.forEach(t => { t.enabled = enabled })
  localMedia.set({ ...media, [key]: enabled })
  try { await syncMedia() } catch (error) { report(error) }
  return enabled
}
export const toggleAudio = () => toggle('audio')
export const toggleVideo = () => toggle('video')
export function stopLocalStream() {
  const media = get(localMedia)
  media.screenStream?.getTracks().forEach(t => { t.onended = null; t.stop() })
  media.stream?.getTracks().forEach(t => t.stop())
  localMedia.set(emptyMedia())
}
export async function getMediaDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return { audioInputs: devices.filter(d => d.kind === 'audioinput'), videoInputs: devices.filter(d => d.kind === 'videoinput'), audioOutputs: devices.filter(d => d.kind === 'audiooutput') }
}
export async function switchCamera(id: string) { await setDevice('video', id) }
export async function switchMicrophone(id: string) { await setDevice('audio', id) }
export async function switchAudioOutput(id: string) { localMedia.update(m => ({ ...m, audioOutputDeviceId: id })) }
export async function startScreenShare(): Promise<boolean> {
  if (changing.has('screen') || get(localMedia).screenSharing) return false
  changing.add('screen')
  const run = generation
  let screen: MediaStream | undefined
  try {
    screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 15 } }, audio: false })
    if (run !== generation) { screen.getTracks().forEach(t => t.stop()); return false }
    const track = screen.getVideoTracks()[0]
    if (!track) throw new Error('Screen unavailable')
    track.onended = () => { void stopScreenShare() }
    localMedia.update(m => ({ ...m, screenStream: screen!, screenSharing: true }))
    await syncMedia()
    return true
  } catch (error) {
    screen?.getTracks().forEach(t => t.stop())
    if (run === generation) {
      localMedia.update(m => ({ ...m, screenStream: null, screenSharing: false }))
      await syncMedia().catch(() => {})
      if (!(error instanceof DOMException && ['NotAllowedError', 'AbortError'].includes(error.name))) report(error)
    }
    return false
  } finally { changing.delete('screen') }
}
export async function stopScreenShare() {
  const media = get(localMedia)
  media.screenStream?.getTracks().forEach(t => { t.onended = null; t.stop() })
  localMedia.update(m => ({ ...m, screenStream: null, screenSharing: false }))
  await syncMedia().catch(report)
}
export async function toggleScreenShare() {
  if (get(localMedia).screenSharing) { await stopScreenShare(); return false }
  return startScreenShare()
}

export async function joinRoom(secret: string) {
  if (active) await leaveRoom()
  const run = ++generation
  const current = get(identity)
  if (!current) throw new Error('Not logged in')
  meetingError.set('')
  const encryption = createMeetingEncryption(secret)
  const signer = createNostrIdentitySignerFromSecretKey(hexToBytes(secret))
  const fipsIdentity = await generateIdentity()
  if (run !== generation) return
  const peer = toHex(fipsIdentity.publicKey)
  const issuedAt = Date.now()
  const binding = await current.signer.signEvent({ kind: MEETING_BINDING_KIND, created_at: Math.floor(issuedAt / 1000), tags: [['r', encryption.roomPubkey]], content: JSON.stringify({ v: 1, peer, issuedAt, name: getProfileDisplayName(undefined, current.pubkey, current.displayName) }) })
  if (run !== generation) return
  const connections = new Set<RTCPeerConnection>()
  const direct = new WebRtcTransport({
    // A replaced inbound negotiation can outlive the transport's active links.
    // Keep ownership of each browser connection until it is actually closed.
    rtcPeerConnection: class extends RTCPeerConnection {
      constructor(config?: RTCConfiguration) {
        super(config)
        connections.add(this)
      }
      override close() {
        connections.delete(this)
        super.close()
      }
    },
    relays: [], advertiseOnNostr: false, acceptConnections: true, autoConnect: false,
    allowIncomingPeer: (peer): boolean => run === generation && transport.hasPeer(peer),
    ordered: false, maxRetransmits: 0,
    ...(import.meta.env.VITE_FIPS_STUN_SERVERS !== undefined ? { stunServers: import.meta.env.VITE_FIPS_STUN_SERVERS.split(',').filter(Boolean) } : {}),
  })
  const node = new FipsNode({ identity: fipsIdentity, transports: [new WebSocketTransport({ seedUrls: seeds }), direct], strictClient: true })
  if (import.meta.env.DEV) {
    const fipsErrors: Array<{ where: string; msg: string; t: number }> = []
    Object.assign(window, { __DEBUG_FIPS_ERRORS: fipsErrors })
    node.on('error', (e: any) => fipsErrors.push({ where: String(e?.where), msg: String(e?.err?.message ?? e?.err), t: Math.round(performance.now()) }))
  }
  async function stopNode() {
    try { await node.stop() }
    finally { for (const connection of connections) connection.close() }
  }
  const localPeer = canonicalPeer(peer)
  const directAddresses = new Map<string, { address: string; dialAfter: number }>()
  const established = new Map<string, Set<string>>()
  node.on('peer', value => {
    const event = value as PeerEvent & { peerId?: string }
    if (event.remoteAddr.transport !== 'webrtc') return
    const id = authenticatedMeetingPeer(event.remotePubkey, event.peerId)
    if (!id) return
    const paths = established.get(id) ?? new Set<string>()
    if (event.state === 'connected') {
      paths.add(event.remoteAddr.addr)
      established.set(id, paths)
    } else {
      paths.delete(event.remoteAddr.addr)
      if (paths.size === 0) established.delete(id)
    }
    if (run === generation) active?.transport.refreshTopology()
  })
  if (import.meta.env.DEV) Object.assign(window, { __DEBUG_DIRECT_PEERS: established })
  const retireDirect = (peer: string) => {
    const remote = directAddresses.get(peer)
    directAddresses.delete(peer)
    established.delete(peer)
    if (remote) void direct.close({ transport: 'webrtc', addr: remote.address }).catch(() => {})
  }
  const connectDirect = (peer: string) => {
    const remote = directAddresses.get(peer)
    if (run === generation && remote && performance.now() >= remote.dialAfter && transport.hasPeer(peer) && !established.has(peer)) {
      void node.connect({ transport: 'webrtc', addr: remote.address }).catch(() => {})
    }
  }
  const isMobile = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0 && typeof window !== 'undefined' && window.innerWidth < 768
  const urlSfu = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('sfu') : null
  const dedicatedForwarder = (typeof window !== 'undefined' ? (window as any).__MEETING_DEDICATED_FORWARDER : undefined) || urlSfu || undefined
  const maxVideoDecoders = (typeof window !== 'undefined' ? (window as any).__MEETING_MAX_VIDEO_DECODERS : undefined) ?? (isMobile ? 4 : 9)
  const layerRecoveryMs = typeof window !== 'undefined' ? (window as any).__MEETING_LAYER_RECOVERY_MS : undefined

  const transport: MeetingTransport = new MeetingTransport(node, encryption.roomPubkey.slice(0, 32), {
    connected(peer) {
      if (run !== generation) return
      updateParticipant(peer, { connectionState: 'connected' })
      connectDirect(peer)
      media.requestKeyframe()
    },
    heartbeat: connectDirect,
    failed(peer) { if (run === generation) updateParticipant(peer, { connectionState: 'failed' }) },
    leave(peer) { if (run === generation) { retireDirect(peer); removeParticipant(peer) } },
    state(peer, state) {
      if (run !== generation) return
      updateParticipant(peer, state)
      media.setPeerScreen(peer, state.screenSharing)
    },
    message(peer, message) {
      if (run !== generation) return
      const sender = findParticipant(get(participants), peer)
      if (!sender) return
      chatMessages.update(messages => [...messages, { ...message, from: sender.pubkey, fromName: sender.displayName }])
      unreadCount.update(n => n + 1)
    },
    media(peer, frame) { media.receive(peer, frame) },
    keyframe(trackId) { media.requestKeyframe(trackId) },
    bitrate(bitsPerSecond) { media.setVideoBitrate(bitsPerSecond) },
    layerBitrates(bitrates) { media.setLayerBitrates(bitrates) },
    demand(demand) { media.setDemand(demand) },
    error: report,
  }, {
    identity: fipsIdentity,
    dedicatedForwarder,
    maxVideoDecoders,
    mobile: isMobile,
    background: typeof document !== 'undefined' ? document.visibilityState !== 'visible' : false,
    layerRecoveryMs,
    getDirectPeers: () => new Set(established.keys()),
  })
  if (import.meta.env.DEV) {
    Object.assign(window, {
      __DEBUG_MEETING_TRANSPORT: () => transport.metrics(),
      __SET_MEETING_SUB_OVERRIDES: (overrides?: Record<string, Partial<PeerSubscription>>) => {
        if (!overrides) { transport.setSubscriptionOverrides(undefined); return }
        const map = new Map<string, Partial<PeerSubscription>>()
        const currentParticipants = get(participants)
        for (const [key, value] of Object.entries(overrides)) {
          // Accept either displayName, owner pubkey, or canonical FIPS peer.
          const byName = [...currentParticipants.values()].find(p => p.displayName === key || p.pubkey === key || p.fipsPeer === key)
          map.set(byName?.fipsPeer ?? canonicalPeer(key), value)
        }
        transport.setSubscriptionOverrides(map)
      },
    })
  }
  let media: MeetingMedia
  try {
    media = await MeetingMedia.open((frame, allowed) => transport.sendMedia(frame, allowed),
      (peer, stream) => { if (run === generation) updateParticipant(peer, { stream }) },
      (peer, trackId) => transport.requestKeyframe(peer, trackId), report)
    if (run !== generation) { media.close(); await transport.close(); await stopNode(); return }
    const onPageHide = (event: PageTransitionEvent) => {
      // A cached page keeps this session and its signed presence binding.
      // Only announce departure when the page is actually being discarded.
      if (!event.persisted) void Promise.allSettled(transport.sendLeave())
    }
    const onVisibilityChange = () => {
      if (run === generation) transport.setBackground(document.visibilityState !== 'visible')
    }
    const unsubFocus = focusedPubkey.subscribe(pubkey => {
      if (run !== generation) return
      const focused = pubkey ? get(participants).get(pubkey)?.fipsPeer ?? null : null
      transport.setViewport(focused)
    })
    window.addEventListener('pagehide', onPageHide)
    document.addEventListener('visibilitychange', onVisibilityChange)
    active = { stopNode, transport, media, roomPubkey: encryption.roomPubkey, onPageHide, onVisibilityChange, unsubFocus }
    await node.start()
    if (run !== generation) { await stopNode(); return }
    const room = active!
    const runtime = getNostrRuntime()
    let lastPresenceAt = 0
    const sendPresence = async () => {
      if (run !== generation) return
      lastPresenceAt = performance.now()
      const now = Math.floor(Date.now() / 1000)
      const event = await signer.signEvent({ kind: MEETING_PRESENCE_KIND, created_at: now, tags: [['expiration', String(now + 60)]], content: encryption.encrypt(JSON.stringify({ type: 'fips-presence', binding })) })
      if (run === generation) void runtime.publish(event, PRESENCE_PUBLISH_OPTIONS).catch(() => {})
    }
    // Coalesce burst peer discoveries into one reply while still responding promptly to late joiners.
    const schedulePresence = () => {
      if (run !== generation || room.presenceTimer !== undefined) return
      const wait = Math.max(0, 150 - (performance.now() - lastPresenceAt))
      if (wait === 0) { void sendPresence().catch(() => {}); return }
      room.presenceTimer = setTimeout(() => {
        room.presenceTimer = undefined
        void sendPresence().catch(() => {})
      }, Math.ceil(wait))
    }
    const joinedAt = Math.floor(Date.now() / 1000) - 5
    const revisions = new Map<string, number>()
    room.discovery = startMeetingDiscovery({
      runtime, node, localPeerId: localPeer, roomPubkey: encryption.roomPubkey, since: joinedAt,
      peers: () => transport.peerIds(),
      onReady: () => { void sendPresence().catch(() => {}) },
      onEvent: async event => {
        if (run !== generation || event.created_at < joinedAt) return
        try {
          const payload = JSON.parse(encryption.decrypt(event.content))
          if (payload.type !== 'fips-presence') return
          const data = readMeetingPresence(payload.binding, encryption.roomPubkey, Date.now(), revisions.get(payload.binding?.pubkey))
          if (!data || data.owner === current.pubkey) return
          const { peer, owner } = data
          const existing = get(participants).get(owner)
          if (existing?.fipsPeer === peer) return
          // A refreshed browser has a fresh session key. Replace only this owner's session.
          if (existing) {
            retireDirect(existing.fipsPeer)
            removeParticipant(existing.fipsPeer)
          }
          if (findParticipant(get(participants), peer)) return
          revisions.set(owner, data.issuedAt)
          participants.update(map => new Map(map).set(owner, { pubkey: owner, displayName: data.name, fipsPeer: peer, stream: null, audioEnabled: false, videoEnabled: false, screenSharing: false, connectionState: 'connecting' }))
          addProfileToCache({ pubkey: owner, name: data.name, display_name: data.name })
          // Give one endpoint the first offer. The other can dial on a later
          // heartbeat if the preferred endpoint can only accept connections.
          directAddresses.set(peer, { address: data.address, dialAfter: localPeer < peer ? 0 : performance.now() + 1500 })
          // Newcomer initiates FSP hello immediately (N distinct targets -> zero seed
          // per-target lookup throttling); existing peers fall back with staggered delay.
          const isInitiator = issuedAt > data.issuedAt || (issuedAt === data.issuedAt && localPeer < peer)
          const staggerSlot = parseInt(localPeer.slice(2, 6), 16) % 8
          transport.addPeer(peer, isInitiator ? 0 : 2500 + staggerSlot * 600)
          room.discovery?.refreshPeers()
          await media.addPeer(peer)
          if (run === generation) schedulePresence()
        } catch { /* Ignore malformed or unrelated discovery messages. */ }
      },
    })
    room.interval = setInterval(() => { void sendPresence().catch(() => {}) }, 15000)
  } catch (error) {
    await transport.close(); await stopNode().catch(() => {})
    if (run === generation) await leaveRoom()
    throw error
  }
}
export async function leaveRoom() {
  generation++
  const room = active
  active = undefined
  if (room) {
    if (room.onPageHide) window.removeEventListener('pagehide', room.onPageHide)
    if (room.onVisibilityChange) document.removeEventListener('visibilitychange', room.onVisibilityChange)
    room.unsubFocus?.()
    clearInterval(room.interval)
    if (room.presenceTimer !== undefined) clearTimeout(room.presenceTimer)
    room.media.close()
  }
  stopLocalStream(); participants.set(new Map()); chatMessages.set([]); unreadCount.set(0); focusedPubkey.set(null); meetingError.set('')
  if (room) {
    // Final subscription frames can still use the admitted room peers.
    try { await room.discovery?.close() }
    finally { await room.transport.close().finally(room.stopNode) }
  }
}
export function getMeetingPubkey() { return active?.roomPubkey ?? null }
export function sendChatMessage(text: string) {
  const current = get(identity)
  if (!current || !active || !text.trim()) return false
  try {
    const message = active.transport.chat(text)
    chatMessages.update(messages => [...messages, { ...message, from: current.pubkey, fromName: getProfileDisplayName(undefined, current.pubkey, current.displayName) }])
    return true
  } catch (error) { report(error); return false }
}
export function clearUnreadCount() { unreadCount.set(0) }
