import { expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey } from 'nostr-tools'
import { readMeetingPresence } from './meetingPresence'

const room = 'ab'.repeat(32)
const peer = `03${'11'.repeat(32)}`
const now = Date.now()
const key = generateSecretKey()
function binding(overrides = {}) {
  return finalizeEvent({
    kind: 25051, created_at: Math.floor(now / 1000), tags: [['r', room]],
    content: JSON.stringify({ v: 1, peer, name: 'Alice', issuedAt: now }), ...overrides,
  }, key)
}
it('binds the signed owner to a fresh per-meeting FIPS identity', () => {
  const event = binding()
  expect(readMeetingPresence(event, room, now)).toEqual({ owner: event.pubkey, peer: `02${peer.slice(2)}`, name: 'Alice', issuedAt: now })
})
it('rejects another room, a forged owner, a malformed peer and a future binding', () => {
  expect(readMeetingPresence(binding(), 'cd'.repeat(32), now)).toBeNull()
  expect(readMeetingPresence({ ...binding(), pubkey: '22'.repeat(32) }, room, now)).toBeNull()
  expect(readMeetingPresence(binding({ content: JSON.stringify({ v: 1, peer: 'bad', name: 'Alice', issuedAt: now }) }), room, now)).toBeNull()
  expect(readMeetingPresence(binding(), room, now - 120000)).toBeNull()
})
it('does not replace a refreshed session with a delayed older announcement', () => {
  expect(readMeetingPresence(binding(), room, now, now + 1)).toBeNull()
  expect(readMeetingPresence(binding(), room, now, now)).toBeNull()
})
