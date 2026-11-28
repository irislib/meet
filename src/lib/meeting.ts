import { writable } from 'svelte/store'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'

const HEX_KEY_RE = /^[0-9a-fA-F]{64}$/

export interface Meeting {
  id: string
  privkeyHex: string
  pubkey: string
  createdAt: Date
}

export const currentMeeting = writable<Meeting | null>(null)

function meetingFromBytes(privkeyBytes: Uint8Array, privkeyHex = bytesToHex(privkeyBytes)): Meeting {
  const pubkey = getPublicKey(privkeyBytes)
  return { id: pubkey.slice(0, 12), privkeyHex, pubkey, createdAt: new Date() }
}

export function createMeeting(): Meeting {
  const meeting = meetingFromBytes(generateSecretKey())
  currentMeeting.set(meeting)
  return meeting
}

export function parseMeetingInput(input: string): Meeting | null {
  let privkeyHex = input.trim()
  if (privkeyHex.includes('#')) privkeyHex = privkeyHex.split('#')[1] || ''
  if (!HEX_KEY_RE.test(privkeyHex)) return null
  try {
    return meetingFromBytes(hexToBytes(privkeyHex), privkeyHex)
  } catch (e) {
    console.error('Failed to parse meeting key:', e)
    return null
  }
}

export function parseMeetingFromHash(): Meeting | null {
  const meeting = parseMeetingInput(window.location.hash)
  if (meeting) currentMeeting.set(meeting)
  return meeting
}

export function getMeetingLink(meeting: Meeting): string {
  return `${window.location.origin}${window.location.pathname}#${meeting.privkeyHex}`
}

export function isInMeeting(): boolean {
  return HEX_KEY_RE.test(window.location.hash.slice(1))
}

export function leaveMeeting(): void {
  currentMeeting.set(null)
  history.replaceState(null, '', window.location.pathname + window.location.search)
}
