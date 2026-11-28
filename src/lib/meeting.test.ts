import { describe, expect, it } from 'vitest'
import { parseMeetingInput } from './meeting'

const sampleHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

describe('meeting link parsing', () => {
  it('parses a raw hex secret or a full meeting URL with fragment', () => {
    const direct = parseMeetingInput(`  ${sampleHex}  `)
    const fromUrl = parseMeetingInput(`https://meet.iris.to/#${sampleHex}`)
    expect(direct).not.toBeNull()
    expect(fromUrl).not.toBeNull()
    expect(direct?.privkeyHex).toBe(sampleHex)
    expect(fromUrl?.pubkey).toBe(direct?.pubkey)
    expect(direct?.id).toBe(direct?.pubkey.slice(0, 12))
  })

  it('rejects malformed inputs', () => {
    expect(parseMeetingInput('')).toBeNull()
    expect(parseMeetingInput('https://meet.iris.to/#short')).toBeNull()
    expect(parseMeetingInput('not-a-meeting')).toBeNull()
  })
})
