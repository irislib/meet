import { expect, it } from 'vitest'
import { DEFAULT_MEETING_RELAYS, resolveRelayPolicy } from './relayPolicy'

it('adds Ditto only to public profile discovery on fresh defaults', () => {
  const policy = resolveRelayPolicy(undefined)
  expect(policy.meeting).toEqual(DEFAULT_MEETING_RELAYS)
  expect(policy.meeting).not.toContain('wss://relay.ditto.pub')
  expect(policy.publicProfiles).toEqual(['wss://relay.ditto.pub', ...DEFAULT_MEETING_RELAYS])
})
it.each(['', ',', 'ws://127.0.0.1:1234', 'wss://custom.example', DEFAULT_MEETING_RELAYS.join(',')])(
  'keeps explicit public/private relay policy exact: %s', (value: string) => {
    const policy = resolveRelayPolicy(value)
    expect(policy.meeting).toEqual(value.split(',').filter(Boolean))
    expect(policy.publicProfiles).toEqual(policy.meeting)
  },
)
