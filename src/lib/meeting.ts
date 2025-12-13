import { writable } from 'svelte/store'
import { generateSecretKey, getPublicKey } from 'nostr-tools'

// Helper functions
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

export interface Meeting {
  id: string
  privkeyHex: string
  pubkey: string
  createdAt: Date
}

export const currentMeeting = writable<Meeting | null>(null)

// Generate a new meeting with its own identity
export function createMeeting(): Meeting {
  const privkeyBytes = generateSecretKey()
  const pubkey = getPublicKey(privkeyBytes)
  const privkeyHex = bytesToHex(privkeyBytes)

  const meeting: Meeting = {
    id: pubkey.slice(0, 12),
    privkeyHex,
    pubkey,
    createdAt: new Date(),
  }

  currentMeeting.set(meeting)
  return meeting
}

// Parse meeting from URL hash containing hex privkey
export function parseMeetingFromHash(): Meeting | null {
  const hash = window.location.hash
  if (!hash || hash.length < 2) return null

  const privkeyHex = hash.slice(1)

  // Validate hex format (64 chars for 32 bytes)
  if (!/^[0-9a-fA-F]{64}$/.test(privkeyHex)) return null

  try {
    const privkeyBytes = hexToBytes(privkeyHex)
    const pubkey = getPublicKey(privkeyBytes)

    const meeting: Meeting = {
      id: pubkey.slice(0, 12),
      privkeyHex,
      pubkey,
      createdAt: new Date(),
    }

    currentMeeting.set(meeting)
    return meeting
  } catch (e) {
    console.error('Failed to parse meeting from hash:', e)
  }

  return null
}

// Get the meeting link to share
export function getMeetingLink(meeting: Meeting): string {
  const baseUrl = window.location.origin + window.location.pathname
  return `${baseUrl}#${meeting.privkeyHex}`
}

// Check if we're in a meeting (have meeting key in URL)
export function isInMeeting(): boolean {
  const hash = window.location.hash
  if (hash.length < 2) return false
  const key = hash.slice(1)
  return /^[0-9a-fA-F]{64}$/.test(key)
}

// Leave the current meeting
export function leaveMeeting(): void {
  currentMeeting.set(null)
  // Clear hash from URL
  history.replaceState(null, '', window.location.pathname + window.location.search)
}

// Get room ID from meeting (uses pubkey as room identifier)
export function getRoomId(meeting: Meeting): string {
  return meeting.pubkey
}
