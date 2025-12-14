import { writable, get } from 'svelte/store'
import type NDK from '@nostr-dev-kit/ndk'
import { NDKEvent, NDKSubscription, NDKPrivateKeySigner } from '@nostr-dev-kit/ndk'
import { identity, ndk } from './identity'
import { getDisplayName } from './animalNames'
import { createMeetingEncryption, encryptForPeer, decryptFromPeer, type MeetingEncryption } from './encryption'
import { getLocalProfile, addProfileToCache, type Profile } from './profile'

export type ConnectionState = 'connecting' | 'connected' | 'failed'

export interface Participant {
  pubkey: string
  displayName: string
  stream: MediaStream | null
  peerConnection: RTCPeerConnection | null
  dataChannel: RTCDataChannel | null
  audioEnabled: boolean
  videoEnabled: boolean
  connectionState: ConnectionState
}

export interface ChatMessage {
  id: string
  from: string
  fromName: string
  text: string
  timestamp: number
}

// Data channel message types
interface DataChannelMessage {
  type: 'chat' | 'profile'
  data: any
}

export interface LocalMedia {
  stream: MediaStream | null
  screenStream: MediaStream | null
  audioEnabled: boolean
  videoEnabled: boolean
  screenSharing: boolean
  audioDeviceId: string | null
  videoDeviceId: string | null
}

// Inner message (encrypted in the Nostr event)
// Direct messages (offer/answer/ice-candidate) have their data field further encrypted
// with a conversation key between sender and recipient for true E2E encryption
interface SignalPayload {
  type: 'offer' | 'answer' | 'ice-candidate' | 'presence' | 'leave' | 'media-state'
  from: string // sender's identity pubkey
  fromName: string
  to?: string // target pubkey for direct messages
  data?: any // for direct messages, this is encrypted with sender↔recipient key
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

// Stores
export const participants = writable<Map<string, Participant>>(new Map())

// Debug: Expose participants to window for e2e testing
if (typeof window !== 'undefined') {
  participants.subscribe(p => {
    (window as any).__DEBUG_PARTICIPANTS = p
  })
}
export const localMedia = writable<LocalMedia>({
  stream: null,
  screenStream: null,
  audioEnabled: false,
  videoEnabled: false,
  screenSharing: false,
  audioDeviceId: null,
  videoDeviceId: null,
})
export const chatMessages = writable<ChatMessage[]>([])
export const unreadCount = writable<number>(0)
export const focusedPubkey = writable<string | null>(null)

// Kind for signaling events
const SIGNAL_KIND = 25050

// Persist media preferences
const MEDIA_PREFS_KEY = 'iris-meet-media-prefs'

interface MediaPrefs {
  audioEnabled: boolean
  videoEnabled: boolean
}

function loadMediaPrefs(): MediaPrefs {
  try {
    const stored = localStorage.getItem(MEDIA_PREFS_KEY)
    if (stored) {
      return JSON.parse(stored)
    }
  } catch {
    // ignore
  }
  return { audioEnabled: false, videoEnabled: false }
}

function saveMediaPrefs(prefs: MediaPrefs): void {
  try {
    localStorage.setItem(MEDIA_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // ignore
  }
}

// Restore media based on saved preferences
export async function restoreMediaPrefs(): Promise<void> {
  const prefs = loadMediaPrefs()
  if (prefs.audioEnabled) {
    await toggleAudio()
  }
  if (prefs.videoEnabled) {
    await toggleVideo()
  }
}

let meetingEncryption: MeetingEncryption | null = null
let meetingSigner: NDKPrivateKeySigner | null = null
let signalSubscription: NDKSubscription | null = null
let presenceInterval: ReturnType<typeof setInterval> | null = null

// ICE candidate queue per peer (for candidates received before remote description)
const iceCandidateQueues = new Map<string, RTCIceCandidateInit[]>()

// Perfect negotiation state per peer
const makingOffer = new Map<string, boolean>()

// Track processed message timestamps to avoid duplicates
const processedMessages = new Set<string>()

export async function getLocalStream(video = true, audio = true): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: video ? {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: 'user',
    } : false,
    audio: audio ? {
      echoCancellation: true,
      noiseSuppression: true,
    } : false,
  })

  // Get device IDs from the tracks
  const audioTrack = stream.getAudioTracks()[0]
  const videoTrack = stream.getVideoTracks()[0]
  const audioDeviceId = audioTrack?.getSettings().deviceId || null
  const videoDeviceId = videoTrack?.getSettings().deviceId || null

  localMedia.set({
    stream,
    screenStream: null,
    audioEnabled: audio,
    videoEnabled: video,
    screenSharing: false,
    audioDeviceId,
    videoDeviceId,
  })

  return stream
}

export async function toggleAudio(): Promise<boolean> {
  const media = get(localMedia)

  // If currently enabled, just disable
  if (media.audioEnabled && media.stream) {
    media.stream.getAudioTracks().forEach(track => {
      track.enabled = false
    })
    localMedia.update(m => ({ ...m, audioEnabled: false }))
    saveMediaPrefs({ audioEnabled: false, videoEnabled: media.videoEnabled })
    broadcastMediaState()
    return false
  }

  // Need to enable - check if we have audio track
  if (media.stream && media.stream.getAudioTracks().length > 0) {
    // Already have track, just enable it
    media.stream.getAudioTracks().forEach(track => {
      track.enabled = true
    })
    localMedia.update(m => ({ ...m, audioEnabled: true }))
    saveMediaPrefs({ audioEnabled: true, videoEnabled: media.videoEnabled })
    broadcastMediaState()
    return true
  }

  // No audio track yet - request permission
  try {
    const audioStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    })

    const audioTrack = audioStream.getAudioTracks()[0]
    const audioDeviceId = audioTrack?.getSettings().deviceId || null

    // Create or add to existing stream
    if (media.stream) {
      media.stream.addTrack(audioTrack)
    } else {
      localMedia.update(m => ({ ...m, stream: audioStream }))
    }

    // Add track to all peer connections
    get(participants).forEach(participant => {
      const pc = participant.peerConnection
      if (pc) {
        pc.addTrack(audioTrack, media.stream || audioStream)
      }
    })

    localMedia.update(m => ({
      ...m,
      stream: m.stream || audioStream,
      audioEnabled: true,
      audioDeviceId,
    }))
    saveMediaPrefs({ audioEnabled: true, videoEnabled: media.videoEnabled })
    broadcastMediaState()
    return true
  } catch (err) {
    console.error('Error getting audio:', err)
    return false
  }
}

export async function toggleVideo(): Promise<boolean> {
  const media = get(localMedia)

  // If currently enabled, just disable
  if (media.videoEnabled && media.stream) {
    media.stream.getVideoTracks().forEach(track => {
      track.enabled = false
    })
    localMedia.update(m => ({ ...m, videoEnabled: false }))
    saveMediaPrefs({ audioEnabled: media.audioEnabled, videoEnabled: false })
    broadcastMediaState()
    return false
  }

  // Need to enable - check if we have video track
  if (media.stream && media.stream.getVideoTracks().length > 0) {
    // Already have track, just enable it
    media.stream.getVideoTracks().forEach(track => {
      track.enabled = true
    })
    localMedia.update(m => ({ ...m, videoEnabled: true }))
    saveMediaPrefs({ audioEnabled: media.audioEnabled, videoEnabled: true })
    broadcastMediaState()
    return true
  }

  // No video track yet - request permission
  try {
    const videoStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    })

    const videoTrack = videoStream.getVideoTracks()[0]
    const videoDeviceId = videoTrack?.getSettings().deviceId || null

    // Create or add to existing stream
    if (media.stream) {
      media.stream.addTrack(videoTrack)
    } else {
      localMedia.update(m => ({ ...m, stream: videoStream }))
    }

    // Add track to all peer connections
    get(participants).forEach(participant => {
      const pc = participant.peerConnection
      if (pc) {
        pc.addTrack(videoTrack, media.stream || videoStream)
      }
    })

    localMedia.update(m => ({
      ...m,
      stream: m.stream || videoStream,
      videoEnabled: true,
      videoDeviceId,
    }))
    saveMediaPrefs({ audioEnabled: media.audioEnabled, videoEnabled: true })
    broadcastMediaState()
    return true
  } catch (err) {
    console.error('Error getting video:', err)
    return false
  }
}

export function stopLocalStream(): void {
  const media = get(localMedia)
  if (media.stream) {
    media.stream.getTracks().forEach(track => track.stop())
  }
  if (media.screenStream) {
    media.screenStream.getTracks().forEach(track => track.stop())
  }
  localMedia.set({ stream: null, screenStream: null, audioEnabled: false, videoEnabled: false, screenSharing: false, audioDeviceId: null, videoDeviceId: null })
}

// Get available media devices
export async function getMediaDevices(): Promise<{ audioInputs: MediaDeviceInfo[], videoInputs: MediaDeviceInfo[] }> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return {
    audioInputs: devices.filter(d => d.kind === 'audioinput'),
    videoInputs: devices.filter(d => d.kind === 'videoinput'),
  }
}

// Switch camera
export async function switchCamera(deviceId: string): Promise<void> {
  const media = get(localMedia)
  if (!media.stream) return

  // Stop current video tracks
  media.stream.getVideoTracks().forEach(track => track.stop())

  // Get new video stream with specific device
  const newStream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
  })

  const newVideoTrack = newStream.getVideoTracks()[0]

  // Replace track in stream
  media.stream.getVideoTracks().forEach(track => media.stream!.removeTrack(track))
  media.stream.addTrack(newVideoTrack)

  // Replace track in all peer connections
  get(participants).forEach(participant => {
    const pc = participant.peerConnection
    if (pc) {
      const sender = pc.getSenders().find(s => s.track?.kind === 'video')
      if (sender) {
        sender.replaceTrack(newVideoTrack)
      }
    }
  })

  localMedia.update(m => ({ ...m, videoEnabled: true, videoDeviceId: deviceId }))
}

// Switch microphone
export async function switchMicrophone(deviceId: string): Promise<void> {
  const media = get(localMedia)
  if (!media.stream) return

  // Stop current audio tracks
  media.stream.getAudioTracks().forEach(track => track.stop())

  // Get new audio stream with specific device
  const newStream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true },
  })

  const newAudioTrack = newStream.getAudioTracks()[0]

  // Replace track in stream
  media.stream.getAudioTracks().forEach(track => media.stream!.removeTrack(track))
  media.stream.addTrack(newAudioTrack)

  // Replace track in all peer connections
  get(participants).forEach(participant => {
    const pc = participant.peerConnection
    if (pc) {
      const sender = pc.getSenders().find(s => s.track?.kind === 'audio')
      if (sender) {
        sender.replaceTrack(newAudioTrack)
      }
    }
  })

  localMedia.update(m => ({ ...m, audioEnabled: true, audioDeviceId: deviceId }))
}

// Start screen sharing
export async function startScreenShare(): Promise<boolean> {
  try {
    const screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always' } as any,
      audio: false,
    })

    const screenTrack = screenStream.getVideoTracks()[0]

    // Handle when user stops sharing via browser UI
    screenTrack.onended = () => {
      stopScreenShare()
    }

    // Replace video track in all peer connections with screen track
    get(participants).forEach(participant => {
      const pc = participant.peerConnection
      if (pc) {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video')
        if (sender) {
          sender.replaceTrack(screenTrack)
        }
      }
    })

    localMedia.update(m => ({ ...m, screenStream, screenSharing: true }))
    return true
  } catch (err) {
    console.error('Error starting screen share:', err)
    return false
  }
}

// Stop screen sharing
export function stopScreenShare(): void {
  const media = get(localMedia)

  if (media.screenStream) {
    media.screenStream.getTracks().forEach(track => track.stop())
  }

  // Restore camera track in all peer connections
  const cameraTrack = media.stream?.getVideoTracks()[0]
  if (cameraTrack) {
    get(participants).forEach(participant => {
      const pc = participant.peerConnection
      if (pc) {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video')
        if (sender) {
          sender.replaceTrack(cameraTrack)
        }
      }
    })
  }

  localMedia.update(m => ({ ...m, screenStream: null, screenSharing: false }))
}

// Toggle screen sharing
export async function toggleScreenShare(): Promise<boolean> {
  const media = get(localMedia)
  if (media.screenSharing) {
    stopScreenShare()
    return false
  } else {
    return await startScreenShare()
  }
}

async function sendSignal(payload: Omit<SignalPayload, 'from' | 'fromName'>): Promise<void> {
  const ndkInstance = get(ndk)
  const currentIdentity = get(identity)
  if (!ndkInstance || !currentIdentity || !meetingEncryption || !meetingSigner) return

  const isDirectMessage = payload.to && ['offer', 'answer', 'ice-candidate'].includes(payload.type)

  // For direct messages, encrypt the data field with sender↔recipient key
  let dataToSend = payload.data
  if (isDirectMessage && payload.data) {
    const encryptedData = await encryptForPeer(payload.data, payload.to!)
    if (!encryptedData) {
      console.error('Failed to encrypt data for peer')
      return
    }
    dataToSend = encryptedData
  }

  const fullPayload: SignalPayload = {
    type: payload.type,
    from: currentIdentity.pubkey,
    fromName: getDisplayName(currentIdentity.pubkey, currentIdentity.displayName),
    to: payload.to,
    data: dataToSend,
  }

  // Encrypt the payload with the meeting key
  const plaintext = JSON.stringify(fullPayload)
  const ciphertext = meetingEncryption.encrypt(plaintext, meetingEncryption.roomPrivkey)

  const event = new NDKEvent(ndkInstance)
  event.kind = SIGNAL_KIND
  event.content = ciphertext

  // Sign with meeting's key so events are authored by meeting pubkey
  await event.sign(meetingSigner)
  await event.publish()
}

async function broadcastMediaState(): Promise<void> {
  const media = get(localMedia)
  if (!meetingEncryption) return

  await sendSignal({
    type: 'media-state',
    data: {
      audioEnabled: media.audioEnabled,
      videoEnabled: media.videoEnabled,
    },
  })
}

function setupDataChannel(dc: RTCDataChannel, remotePubkey: string): void {
  dc.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data) as DataChannelMessage

      if (msg.type === 'profile') {
        // Add received profile to cache (updates Name/Avatar components)
        const profile = msg.data as Profile
        profile.pubkey = remotePubkey
        addProfileToCache(profile)
        // Also update participant's display name
        const name = profile.display_name || profile.name
        if (name) {
          participants.update(p => {
            const participant = p.get(remotePubkey)
            if (participant) {
              participant.displayName = name
            }
            return new Map(p)
          })
        }
      } else if (msg.type === 'chat') {
        const chatMsg = msg.data as ChatMessage
        chatMessages.update(msgs => [...msgs, chatMsg])
        unreadCount.update(n => n + 1)
      }
    } catch (err) {
      console.warn('Failed to parse data channel message:', err)
    }
  }

  dc.onopen = () => {
    console.log(`Data channel open with ${remotePubkey.slice(0, 8)}`)
    participants.update(p => {
      const participant = p.get(remotePubkey)
      if (participant) {
        participant.dataChannel = dc
        participant.connectionState = 'connected'
      }
      return new Map(p)
    })

    // Send our local profile rumor (for anonymous users)
    const localProfile = getLocalProfile()
    if (localProfile) {
      const profileMsg: DataChannelMessage = {
        type: 'profile',
        data: localProfile,
      }
      dc.send(JSON.stringify(profileMsg))
    }
  }

  dc.onclose = () => {
    console.log(`Data channel closed with ${remotePubkey.slice(0, 8)}`)
  }
}

function createPeerConnection(remotePubkey: string, createDataChannel: boolean): RTCPeerConnection {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
  const media = get(localMedia)

  // Create data channel only if we're the deterministic initiator
  // (higher pubkey = "impolite" = creates data channel)
  if (createDataChannel) {
    const dc = pc.createDataChannel('chat')
    setupDataChannel(dc, remotePubkey)
  }

  // Handle incoming data channel
  pc.ondatachannel = (event) => {
    setupDataChannel(event.channel, remotePubkey)
  }

  // Add local tracks and ensure we can receive audio/video even if not sending
  const hasAudio = media.stream?.getAudioTracks().length > 0
  const hasVideo = media.stream?.getVideoTracks().length > 0

  if (media.stream) {
    media.stream.getTracks().forEach(track => {
      pc.addTrack(track, media.stream!)
    })
  }

  // Add receive-only transceivers for media types we're not sending
  // This ensures SDP includes audio/video sections so we can receive remote tracks
  if (!hasAudio) {
    pc.addTransceiver('audio', { direction: 'recvonly' })
  }
  if (!hasVideo) {
    pc.addTransceiver('video', { direction: 'recvonly' })
  }

  // Handle ICE candidates
  pc.onicecandidate = async (event) => {
    if (event.candidate && meetingEncryption) {
      await sendSignal({
        type: 'ice-candidate',
        to: remotePubkey,
        data: event.candidate.toJSON(),
      })
    }
  }

  // Handle remote tracks
  pc.ontrack = (event) => {
    participants.update(p => {
      const participant = p.get(remotePubkey)
      if (participant) {
        participant.stream = event.streams[0] || new MediaStream([event.track])
      }
      return new Map(p)
    })
  }

  // Handle connection state changes
  pc.onconnectionstatechange = () => {
    console.log(`Connection state with ${remotePubkey.slice(0, 8)}: ${pc.connectionState}`)
    if (pc.connectionState === 'failed') {
      participants.update(p => {
        const participant = p.get(remotePubkey)
        if (participant) {
          participant.connectionState = 'failed'
        }
        return new Map(p)
      })
    } else if (pc.connectionState === 'disconnected') {
      // Give a moment for reconnection before removing
      setTimeout(() => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
          removeParticipant(remotePubkey)
        }
      }, 5000)
    }
  }

  // Handle negotiation (perfect negotiation pattern)
  pc.onnegotiationneeded = async () => {
    const currentIdentity = get(identity)
    if (!currentIdentity) return

    try {
      makingOffer.set(remotePubkey, true)
      await pc.setLocalDescription()  // Creates offer automatically
      console.log(`Sending offer to ${remotePubkey.slice(0, 8)}`)
      await sendSignal({
        type: 'offer',
        to: remotePubkey,
        data: pc.localDescription?.toJSON(),
      })
    } catch (err) {
      console.error('Error during negotiation:', err)
    } finally {
      makingOffer.set(remotePubkey, false)
    }
  }

  return pc
}

function removeParticipant(pubkey: string): void {
  participants.update(p => {
    const participant = p.get(pubkey)
    if (participant) {
      participant.peerConnection?.close()
      p.delete(pubkey)
    }
    return new Map(p)
  })
  iceCandidateQueues.delete(pubkey)
  makingOffer.delete(pubkey)
}

async function processQueuedIceCandidates(pubkey: string, pc: RTCPeerConnection): Promise<void> {
  const queue = iceCandidateQueues.get(pubkey)
  if (!queue || queue.length === 0) return

  console.log(`Processing ${queue.length} queued ICE candidates for ${pubkey.slice(0, 8)}`)

  for (const candidate of queue) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate))
    } catch (err) {
      console.warn('Error adding queued ICE candidate:', err)
    }
  }

  iceCandidateQueues.delete(pubkey)
}

async function handleSignalMessage(payload: SignalPayload, eventId: string): Promise<void> {
  const currentIdentity = get(identity)
  if (!currentIdentity) return

  // Ignore our own messages
  if (payload.from === currentIdentity.pubkey) return

  // Ignore targeted messages not for us
  if (payload.to && payload.to !== currentIdentity.pubkey) return

  // Deduplicate by event ID (unique per Nostr event)
  if (processedMessages.has(eventId)) return
  processedMessages.add(eventId)

  // Clean up old message IDs (keep last 1000)
  if (processedMessages.size > 1000) {
    const arr = Array.from(processedMessages)
    arr.slice(0, 500).forEach(id => processedMessages.delete(id))
  }

  // For direct messages, decrypt the data field using sender's pubkey
  const isDirectMessage = payload.to && ['offer', 'answer', 'ice-candidate'].includes(payload.type)
  if (isDirectMessage && payload.data && typeof payload.data === 'string') {
    try {
      payload.data = await decryptFromPeer(payload.data, payload.from)
      if (!payload.data) {
        console.error('Failed to decrypt direct message data')
        return
      }
    } catch (err) {
      console.error('Error decrypting direct message:', err)
      return
    }
  }

  switch (payload.type) {
    case 'presence':
      await handlePresence(payload)
      break
    case 'offer':
      await handleOffer(payload)
      break
    case 'answer':
      await handleAnswer(payload)
      break
    case 'ice-candidate':
      await handleIceCandidate(payload)
      break
    case 'leave':
      handleLeave(payload)
      break
    case 'media-state':
      handleMediaState(payload)
      break
  }
}

async function handlePresence(payload: SignalPayload): Promise<void> {
  const currentIdentity = get(identity)
  if (!currentIdentity) return

  // Check if we already have an active connection
  const existingParticipant = get(participants).get(payload.from)
  if (existingParticipant?.peerConnection) {
    // Already connected, ignore presence
    return
  }

  console.log(`New peer discovered: ${payload.fromName}`)

  // Add to profile cache so Name component can display immediately
  addProfileToCache({
    pubkey: payload.from,
    name: payload.fromName,
    display_name: payload.fromName,
  })

  // Create participant entry if not exists
  if (!existingParticipant) {
    participants.update(p => {
      p.set(payload.from, {
        pubkey: payload.from,
        displayName: payload.fromName,
        stream: null,
        peerConnection: null,
        dataChannel: null,
        audioEnabled: true,
        videoEnabled: true,
        connectionState: 'connecting',
      })
      return new Map(p)
    })
  }

  // Deterministic: higher pubkey is "impolite" and creates data channel
  const weAreImpolite = currentIdentity.pubkey > payload.from
  const pc = createPeerConnection(payload.from, weAreImpolite)

  participants.update(p => {
    const participant = p.get(payload.from)
    if (participant) {
      participant.peerConnection = pc
    }
    return new Map(p)
  })

  // onnegotiationneeded will fire automatically and send the offer
  // (triggered by addTrack or createDataChannel in createPeerConnection)
}

async function handleOffer(payload: SignalPayload): Promise<void> {
  const currentIdentity = get(identity)
  if (!currentIdentity) return

  console.log(`Received offer from ${payload.fromName}`)

  // Add to profile cache so Name component can display immediately
  addProfileToCache({
    pubkey: payload.from,
    name: payload.fromName,
    display_name: payload.fromName,
  })

  // Deterministic: lower pubkey is "polite" (yields on collision)
  const weArePolite = currentIdentity.pubkey < payload.from

  let pc: RTCPeerConnection
  const existingParticipant = get(participants).get(payload.from)

  if (existingParticipant?.peerConnection) {
    pc = existingParticipant.peerConnection

    // Perfect negotiation: detect offer collision
    const offerCollision = makingOffer.get(payload.from) || pc.signalingState !== 'stable'

    if (offerCollision) {
      if (!weArePolite) {
        console.log('Offer collision - we are impolite, ignoring their offer')
        return // Ignore their offer, they will answer ours
      }
      console.log('Offer collision - we are polite, rolling back')
    }
  } else {
    // No connection yet - create one
    // Deterministic: higher pubkey is "impolite" and creates data channel
    const weAreImpolite = !weArePolite
    pc = createPeerConnection(payload.from, weAreImpolite)

    participants.update(p => {
      if (!p.has(payload.from)) {
        p.set(payload.from, {
          pubkey: payload.from,
          displayName: payload.fromName,
          stream: null,
          peerConnection: pc,
          dataChannel: null,
          audioEnabled: true,
          videoEnabled: true,
          connectionState: 'connecting',
        })
      } else {
        p.get(payload.from)!.peerConnection = pc
      }
      return new Map(p)
    })
  }

  try {
    // setRemoteDescription with offer automatically handles rollback if needed
    await pc.setRemoteDescription(new RTCSessionDescription(payload.data))

    // Process any queued ICE candidates
    await processQueuedIceCandidates(payload.from, pc)

    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    await sendSignal({
      type: 'answer',
      to: payload.from,
      data: pc.localDescription?.toJSON(),
    })
  } catch (err) {
    console.error('Error handling offer:', err)
  }
}

async function handleAnswer(payload: SignalPayload): Promise<void> {
  console.log(`Received answer from ${payload.fromName}`)

  const participant = get(participants).get(payload.from)
  if (!participant?.peerConnection) return

  const pc = participant.peerConnection

  // Only set remote description if we're expecting an answer
  if (pc.signalingState !== 'have-local-offer') {
    console.log(`Ignoring answer in state: ${pc.signalingState}`)
    return
  }

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(payload.data))

    // Process any queued ICE candidates
    await processQueuedIceCandidates(payload.from, pc)
  } catch (err) {
    console.error('Error handling answer:', err)
  }
}

async function handleIceCandidate(payload: SignalPayload): Promise<void> {
  const participant = get(participants).get(payload.from)

  if (!participant?.peerConnection || !participant.peerConnection.remoteDescription) {
    // Queue the candidate for later
    if (!iceCandidateQueues.has(payload.from)) {
      iceCandidateQueues.set(payload.from, [])
    }
    iceCandidateQueues.get(payload.from)!.push(payload.data)
    return
  }

  try {
    await participant.peerConnection.addIceCandidate(new RTCIceCandidate(payload.data))
  } catch (err) {
    console.warn('Error adding ICE candidate:', err)
  }
}

function handleLeave(payload: SignalPayload): void {
  console.log(`${payload.fromName} left the room`)
  removeParticipant(payload.from)
}

function handleMediaState(payload: SignalPayload): void {
  participants.update(p => {
    const participant = p.get(payload.from)
    if (participant && payload.data) {
      participant.audioEnabled = payload.data.audioEnabled
      participant.videoEnabled = payload.data.videoEnabled
    }
    return new Map(p)
  })
}

export async function joinRoom(meetingPrivkeyHex: string): Promise<void> {
  const ndkInstance = get(ndk)
  const currentIdentity = get(identity)
  if (!ndkInstance || !currentIdentity) {
    throw new Error('Not logged in')
  }

  meetingEncryption = createMeetingEncryption(meetingPrivkeyHex)
  meetingSigner = new NDKPrivateKeySigner(meetingPrivkeyHex)

  // Clear any stale state
  processedMessages.clear()
  iceCandidateQueues.clear()
  makingOffer.clear()

  // Subscribe to signals authored by the meeting's pubkey
  signalSubscription = ndkInstance.subscribe(
    {
      kinds: [SIGNAL_KIND],
      authors: [meetingEncryption.roomPubkey],
      since: Math.floor(Date.now() / 1000) - 60,
    },
    { closeOnEose: false }
  )

  signalSubscription.on('event', async (event: NDKEvent) => {
    try {
      // Decrypt the message using the meeting key
      const plaintext = meetingEncryption!.decrypt(event.content, meetingEncryption!.roomPubkey)
      const payload = JSON.parse(plaintext) as SignalPayload
      await handleSignalMessage(payload, event.id)
    } catch (err) {
      // Silently ignore decryption errors (could be old messages or from other meetings)
    }
  })

  // Announce presence
  await sendSignal({
    type: 'presence',
  })

  // Periodically announce presence for peer discovery reliability
  presenceInterval = setInterval(async () => {
    try {
      await sendSignal({
        type: 'presence',
      })
    } catch {
      // Ignore errors
    }
  }, 15000) // Every 15 seconds
}

export async function leaveRoom(): Promise<void> {
  // Stop presence announcements
  if (presenceInterval) {
    clearInterval(presenceInterval)
    presenceInterval = null
  }

  if (meetingEncryption) {
    try {
      await sendSignal({
        type: 'leave',
      })
    } catch (err) {
      // Ignore errors when leaving
    }
  }

  // Close all peer connections
  get(participants).forEach(participant => {
    participant.peerConnection?.close()
  })
  participants.set(new Map())

  // Stop subscription
  signalSubscription?.stop()
  signalSubscription = null

  // Stop local media
  stopLocalStream()

  // Clear state
  meetingEncryption = null
  meetingSigner = null
  processedMessages.clear()
  iceCandidateQueues.clear()
  makingOffer.clear()
  chatMessages.set([])
  unreadCount.set(0)
  focusedPubkey.set(null)
}

export function getMeetingPubkey(): string | null {
  return meetingEncryption?.roomPubkey || null
}

export function sendChatMessage(text: string): void {
  const currentIdentity = get(identity)
  if (!currentIdentity || !text.trim()) return

  const msg: ChatMessage = {
    id: `${currentIdentity.pubkey}-${Date.now()}`,
    from: currentIdentity.pubkey,
    fromName: getDisplayName(currentIdentity.pubkey, currentIdentity.displayName),
    text: text.trim(),
    timestamp: Date.now(),
  }

  // Add to our own messages
  chatMessages.update(msgs => [...msgs, msg])

  // Send to all participants via data channel
  const dcMsg: DataChannelMessage = { type: 'chat', data: msg }
  const msgStr = JSON.stringify(dcMsg)
  get(participants).forEach(participant => {
    if (participant.dataChannel?.readyState === 'open') {
      participant.dataChannel.send(msgStr)
    }
  })
}

export function clearUnreadCount(): void {
  unreadCount.set(0)
}
