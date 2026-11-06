// Room presence is encrypted and retains its existing transport destinations.
export const DEFAULT_MEETING_RELAYS = [
  'wss://temp.iris.to', 'wss://relay.damus.io', 'wss://relay.snort.social',
  'wss://relay.nostr.band', 'wss://relay.primal.net', 'wss://nos.lol',
]

export function resolveRelayPolicy(value: string | undefined) {
  const meeting = value === undefined ? [...DEFAULT_MEETING_RELAYS] : value.split(',').filter(Boolean)
  return { meeting, publicProfiles: value === undefined ? ['wss://relay.ditto.pub', ...meeting] : [...meeting] }
}
