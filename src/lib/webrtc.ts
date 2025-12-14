import { writable, get } from 'svelte/store'
import type NDK from '@nostr-dev-kit/ndk'
import { NDKEvent, NDKSubscription, NDKPrivateKeySigner } from '@nostr-dev-kit/ndk'
import { identity, ndk } from './identity'
import { getDisplayName } from './animalNames'
import { createMeetingEncryption, type MeetingEncryption } from './encryption'
import { getLocalProfile, addProfileToCache, type Profile } from './profile'

export interface Participant {
  pubkey: string
  displayName: string
  stream: MediaStream | null
  peerConnection: RTCPeerConnection | null
  dataChannel: RTCDataChannel | null
  audioEnabled: boolean
  videoEnabled: boolean
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

// Inner signed message (encrypted in the Nostr event)
interface SignalPayload {
  type: 'offer' | 'answer' | 'ice-candidate' | 'join' | 'leave' | 'media-state'
  from: string // sender's identity pubkey
  fromName: string
  to?: string // target pubkey for direct messages
  data?: any
  timestamp: number
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

// Stores
export const participants = writable<Map<string, Participant>>(new Map())
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

// ICE candidate queue per peer (for candidates received before remote description)
const iceCandidateQueues = new Map<string, RTCIceCandidateInit[]>()

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

async function sendSignal(payload: Omit<SignalPayload, 'from' | 'fromName' | 'timestamp'>): Promise<void> {
  const ndkInstance = get(ndk)
  const currentIdentity = get(identity)
  if (!ndkInstance || !currentIdentity || !meetingEncryption || !meetingSigner) return

  const fullPayload: SignalPayload = {
    ...payload,
    from: currentIdentity.pubkey,
    fromName: getDisplayName(currentIdentity.pubkey, currentIdentity.displayName),
    timestamp: Date.now(),
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

function createPeerConnection(remotePubkey: string, initiator: boolean): RTCPeerConnection {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
  const media = get(localMedia)

  // Create data channel if we're the initiator
  if (initiator) {
    const dc = pc.createDataChannel('chat')
    setupDataChannel(dc, remotePubkey)
  }

  // Handle incoming data channel
  pc.ondatachannel = (event) => {
    setupDataChannel(event.channel, remotePubkey)
  }

  // Add local tracks
  if (media.stream) {
    media.stream.getTracks().forEach(track => {
      pc.addTrack(track, media.stream!)
    })
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
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      removeParticipant(remotePubkey)
    }
  }

  // Handle renegotiation (when tracks are added after connection established)
  pc.onnegotiationneeded = async () => {
    const currentIdentity = get(identity)
    if (!currentIdentity) return

    // Use polite/impolite pattern - impolite peer initiates offers
    const weArePolite = currentIdentity.pubkey < remotePubkey
    if (weArePolite) {
      // Polite peer waits for offer from impolite peer
      // But we need to signal that we need renegotiation
      // For now, both sides can create offers and glare handling will resolve
    }

    console.log(`Renegotiation needed with ${remotePubkey.slice(0, 8)}`)
    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      await sendSignal({
        type: 'offer',
        to: remotePubkey,
        data: pc.localDescription?.toJSON(),
      })
    } catch (err) {
      console.error('Error during renegotiation:', err)
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

async function handleSignalMessage(payload: SignalPayload): Promise<void> {
  const currentIdentity = get(identity)
  if (!currentIdentity) return

  // Ignore our own messages
  if (payload.from === currentIdentity.pubkey) return

  // Ignore targeted messages not for us
  if (payload.to && payload.to !== currentIdentity.pubkey) return

  // Deduplicate messages
  const msgId = `${payload.from}-${payload.type}-${payload.timestamp}`
  if (processedMessages.has(msgId)) return
  processedMessages.add(msgId)

  // Clean up old message IDs (keep last 1000)
  if (processedMessages.size > 1000) {
    const arr = Array.from(processedMessages)
    arr.slice(0, 500).forEach(id => processedMessages.delete(id))
  }

  switch (payload.type) {
    case 'join':
      await handleJoin(payload)
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

async function handleJoin(payload: SignalPayload): Promise<void> {
  const currentIdentity = get(identity)
  if (!currentIdentity) return

  console.log(`${payload.fromName} joined the room`)

  // Create participant entry if not exists
  const existingParticipants = get(participants)
  if (!existingParticipants.has(payload.from)) {
    participants.update(p => {
      p.set(payload.from, {
        pubkey: payload.from,
        displayName: payload.fromName,
        stream: null,
        peerConnection: null,
        dataChannel: null,
        audioEnabled: true,
        videoEnabled: true,
      })
      return new Map(p)
    })
  }

  // Use deterministic polite/impolite peer to avoid glare
  // Lower pubkey is "polite" (waits), higher is "impolite" (initiates)
  const weArePolite = currentIdentity.pubkey < payload.from

  // Check if we already have an active connection attempt
  const participant = get(participants).get(payload.from)
  if (participant?.peerConnection) {
    // Already have a connection, don't create another
    return
  }

  if (!weArePolite) {
    // We initiate the connection (create offer) and data channel
    const pc = createPeerConnection(payload.from, true)

    participants.update(p => {
      const participant = p.get(payload.from)
      if (participant) {
        participant.peerConnection = pc
      }
      return new Map(p)
    })

    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      await sendSignal({
        type: 'offer',
        to: payload.from,
        data: pc.localDescription?.toJSON(),
      })
    } catch (err) {
      console.error('Error creating offer:', err)
    }
  } else {
    // We're polite - respond with our own join so they know we exist
    // (they may have joined after our original join message was sent)
    await sendSignal({
      type: 'join',
    })
  }
}

async function handleOffer(payload: SignalPayload): Promise<void> {
  const currentIdentity = get(identity)
  if (!currentIdentity) return

  console.log(`Received offer from ${payload.fromName}`)

  let pc: RTCPeerConnection
  const existingParticipant = get(participants).get(payload.from)

  if (existingParticipant?.peerConnection) {
    pc = existingParticipant.peerConnection

    // Handle glare: if we have a local offer pending, check who should back off
    if (pc.signalingState === 'have-local-offer') {
      const weArePolite = currentIdentity.pubkey < payload.from
      if (weArePolite) {
        // We back off, accept their offer
        console.log('Glare detected, we are polite - rolling back')
        await pc.setLocalDescription({ type: 'rollback' })
      } else {
        // We ignore their offer, they should accept ours
        console.log('Glare detected, we are impolite - ignoring their offer')
        return
      }
    }
  } else {
    // We're receiving an offer, so we don't initiate data channel
    pc = createPeerConnection(payload.from, false)

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
        })
      } else {
        p.get(payload.from)!.peerConnection = pc
      }
      return new Map(p)
    })
  }

  try {
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
      await handleSignalMessage(payload)
    } catch (err) {
      // Silently ignore decryption errors (could be old messages or from other meetings)
    }
  })

  // Announce join
  await sendSignal({
    type: 'join',
  })
}

export async function leaveRoom(): Promise<void> {
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
  chatMessages.set([])
  unreadCount.set(0)
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
