// Meeting state and media use one FIPS node. FIPS owns link negotiation and routing.
import { writable, get } from 'svelte/store'
import { FipsNode, generateIdentity, toHex } from '@fips/core'
import { WebRtcTransport } from '@fips/transport-webrtc'
import { WebSocketTransport } from '@fips/transport-websocket'
import { createNostrIdentitySignerFromSecretKey } from '@iris/identity/signers'
import { getProfileDisplayName } from '@iris/svelte-ui/profile'
import { getNostrRuntime } from './nostr'
import { identity } from './identity'
import { createMeetingEncryption } from './encryption'
import { addProfileToCache } from './profile'
import { canonicalPeer, MeetingTransport } from './meetingTransport'
import { MeetingMedia } from './meetingMedia'
import { MEETING_BINDING_KIND, readMeetingPresence } from './meetingPresence'
import { MEETING_PRESENCE_KIND, PRESENCE_PUBLISH_OPTIONS, startMeetingDiscovery } from './meetingDiscovery'

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
  node: FipsNode; transport: MeetingTransport; media: MeetingMedia
  roomPubkey: string; discovery?: ReturnType<typeof startMeetingDiscovery>; interval?: ReturnType<typeof setInterval>
} | undefined

function report(error: unknown) { meetingError.set(error instanceof Error ? error.message : String(error)) }
function updateParticipant(peer: string, update: (participant: Participant) => void) {
  participants.update(map => {
    const participant = [...map.values()].find(p => p.fipsPeer === canonicalPeer(peer))
    if (participant) update(participant)
    return new Map(map)
  })
}
function removeParticipant(peer: string) {
  active?.transport.removePeer(peer); active?.media.removePeer(peer)
  participants.update(map => new Map([...map].filter(([, p]) => p.fipsPeer !== canonicalPeer(peer))))
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
  await room?.media.setCapture(media.stream, media.screenStream, media.audioEnabled, media.videoEnabled || media.screenSharing)
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
export async function getLocalStream(video = true, audio = true): Promise<MediaStream> {
  if (audio) await setDevice('audio')
  if (video) await setDevice('video')
  return get(localMedia).stream ?? new MediaStream()
}
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
  const signer = createNostrIdentitySignerFromSecretKey(Uint8Array.from(secret.match(/../g)!, b => parseInt(b, 16)))
  const fipsIdentity = await generateIdentity()
  if (run !== generation) return
  const peer = toHex(fipsIdentity.publicKey)
  const issuedAt = Date.now()
  const binding = await current.signer.signEvent({ kind: MEETING_BINDING_KIND, created_at: Math.floor(issuedAt / 1000), tags: [['r', encryption.roomPubkey]], content: JSON.stringify({ v: 1, peer, issuedAt, name: getProfileDisplayName(undefined, current.pubkey, current.displayName) }) })
  if (run !== generation) return
  const direct = new WebRtcTransport({
    relays: [], advertiseOnNostr: false, acceptConnections: true, autoConnect: false,
    allowIncomingPeer: (peer): boolean => run === generation && transport.hasPeer(peer),
    ordered: false, maxRetransmits: 0,
    ...(import.meta.env.VITE_FIPS_STUN_SERVERS !== undefined ? { stunServers: import.meta.env.VITE_FIPS_STUN_SERVERS.split(',').filter(Boolean) } : {}),
  })
  const node = new FipsNode({ identity: fipsIdentity, transports: [new WebSocketTransport({ seedUrls: seeds }), direct], routingMode: 'reply_learned' })
  const transport = new MeetingTransport(node, encryption.roomPubkey.slice(0, 32), {
    connected(peer) {
      if (run !== generation) return
      updateParticipant(peer, p => { p.connectionState = 'connected' })
      media.requestKeyframe()
      // FIPS deduplicates dials, negotiates the direct link and chooses the route.
      void node.connect({ transport: 'webrtc', addr: peer }).catch(() => {})
    },
    failed(peer) { if (run === generation) updateParticipant(peer, p => { p.connectionState = 'failed' }) },
    leave(peer) { if (run === generation) removeParticipant(peer) },
    state(peer, state) { if (run === generation) updateParticipant(peer, p => Object.assign(p, state)) },
    message(peer, message) {
      if (run !== generation) return
      const sender = [...get(participants).values()].find(p => p.fipsPeer === peer)
      if (!sender) return
      chatMessages.update(messages => [...messages, { ...message, from: sender.pubkey, fromName: sender.displayName }])
      unreadCount.update(n => n + 1)
    },
    media(peer, frame) { media.receive(peer, frame) },
    keyframe() { media.requestKeyframe() },
    bitrate(bitsPerSecond) { media.setVideoBitrate(bitsPerSecond) },
    error: report,
  })
  let media: MeetingMedia
  try {
    media = await MeetingMedia.open((frame, allowed) => transport.sendMedia(frame, allowed),
      (peer, stream) => { if (run === generation) updateParticipant(peer, p => { p.stream = stream }) },
      peer => transport.requestKeyframe(peer), report)
    if (run !== generation) { media.close(); await transport.close(); await node.stop(); return }
    active = { node, transport, media, roomPubkey: encryption.roomPubkey }
    await node.start()
    if (run !== generation) { await node.stop(); return }
    const room = active!
    const runtime = getNostrRuntime()
    const sendPresence = async () => {
      if (run !== generation) return
      const now = Math.floor(Date.now() / 1000)
      const event = await signer.signEvent({ kind: MEETING_PRESENCE_KIND, created_at: now, tags: [['expiration', String(now + 60)]], content: encryption.encrypt(JSON.stringify({ type: 'fips-presence', binding })) })
      if (run === generation) void runtime.publish(event, PRESENCE_PUBLISH_OPTIONS).catch(() => {})
    }
    const joinedAt = Math.floor(Date.now() / 1000) - 5
    const revisions = new Map<string, number>()
    room.discovery = startMeetingDiscovery({
      runtime, node, localPeerId: canonicalPeer(peer), roomPubkey: encryption.roomPubkey, since: joinedAt,
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
          if (existing) removeParticipant(existing.fipsPeer)
          if ([...get(participants).values()].some(p => p.fipsPeer === peer)) return
          revisions.set(owner, data.issuedAt)
          participants.update(map => new Map(map).set(owner, { pubkey: owner, displayName: data.name, fipsPeer: peer, stream: null, audioEnabled: false, videoEnabled: false, screenSharing: false, connectionState: 'connecting' }))
          addProfileToCache({ pubkey: owner, name: data.name, display_name: data.name })
          transport.addPeer(peer)
          room.discovery?.refreshPeers()
          await media.addPeer(peer)
          if (run === generation) await sendPresence()
        } catch { /* Ignore malformed or unrelated discovery messages. */ }
      },
    })
    room.interval = setInterval(() => { void sendPresence().catch(() => {}) }, 15000)
  } catch (error) {
    await transport.close(); await node.stop().catch(() => {})
    if (run === generation) await leaveRoom()
    throw error
  }
}
export async function leaveRoom() {
  generation++
  const room = active
  active = undefined
  if (room) {
    clearInterval(room.interval); room.media.close()
  }
  stopLocalStream(); participants.set(new Map()); chatMessages.set([]); unreadCount.set(0); focusedPubkey.set(null); meetingError.set('')
  if (room) {
    // The adapter sends its final subscription frames to admitted room peers.
    try { await room.discovery?.close() }
    finally {
      try { await room.transport.close() }
      finally { await room.node.stop() }
    }
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
