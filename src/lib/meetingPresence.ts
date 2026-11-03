import { verifyEvent, type Event } from 'nostr-tools'
import { canonicalPeer } from './meetingTransport'

export const MEETING_BINDING_KIND = 25051
/** Validate the owner's signed session binding after decrypting room discovery. */
export function readMeetingPresence(value: unknown, room: string, now = Date.now(), previousIssuedAt = 0) {
  try {
    const candidate = value as Event
    if (!candidate) return null
    // Drop any library verification cache carried by an in-memory object.
    const event: Event = { id: candidate.id, pubkey: candidate.pubkey, sig: candidate.sig,
      kind: candidate.kind, created_at: candidate.created_at, tags: candidate.tags, content: candidate.content }
    if (event.kind !== MEETING_BINDING_KIND || event.content.length > 2048 ||
      event.created_at > now / 1000 + 60 || !event.tags.some(t => t[0] === 'r' && t[1] === room) ||
      !verifyEvent(event)) return null
    const data = JSON.parse(event.content), peer = canonicalPeer(data.peer)
    if (data.v !== 1 || !peer || typeof data.name !== 'string' || data.name.length > 256 ||
      !Number.isSafeInteger(data.issuedAt) || data.issuedAt <= previousIssuedAt ||
      data.issuedAt > now + 60000 || Math.abs(data.issuedAt / 1000 - event.created_at) > 60) return null
    return { owner: event.pubkey, peer, name: data.name, issuedAt: data.issuedAt as number }
  } catch { return null }
}
