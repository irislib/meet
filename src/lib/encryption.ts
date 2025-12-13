import { nip44, getPublicKey } from 'nostr-tools'
import { get } from 'svelte/store'
import { identity } from './identity'
import type { NDKPrivateKeySigner } from '@nostr-dev-kit/ndk'

// Helper function
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

// NIP-44 encryption using meeting room's shared secret
// The meeting room key (hex privkey) is used to derive encryption keys

export function getConversationKey(privkeyHex: string, pubkeyHex: string): Uint8Array {
  const privkeyBytes = hexToBytes(privkeyHex)
  return nip44.v2.utils.getConversationKey(privkeyBytes, pubkeyHex)
}

export function encrypt(plaintext: string, conversationKey: Uint8Array): string {
  return nip44.v2.encrypt(plaintext, conversationKey)
}

export function decrypt(ciphertext: string, conversationKey: Uint8Array): string {
  return nip44.v2.decrypt(ciphertext, conversationKey)
}

// For meeting rooms, we use a shared room key
// All participants encrypt to the room's pubkey using their own privkey
// This creates a unique encryption context for each participant-room pair

export interface MeetingEncryption {
  roomPubkey: string
  roomPrivkey: string
  encrypt: (plaintext: string, senderPrivkey: string) => string
  decrypt: (ciphertext: string, senderPubkey: string) => string
}

export function createMeetingEncryption(roomPrivkeyHex: string): MeetingEncryption {
  const roomPubkey = getPublicKey(hexToBytes(roomPrivkeyHex))
  // Use room's own key pair for symmetric-like encryption
  // Everyone encrypts TO the room pubkey using the room privkey (shared secret)
  const sharedKey = nip44.v2.utils.getConversationKey(hexToBytes(roomPrivkeyHex), roomPubkey)

  return {
    roomPubkey,
    roomPrivkey: roomPrivkeyHex,

    // Encrypt message using shared room key
    encrypt(plaintext: string, _senderPrivkey: string): string {
      return nip44.v2.encrypt(plaintext, sharedKey)
    },

    // Decrypt message using shared room key
    decrypt(ciphertext: string, _senderPubkey: string): string {
      return nip44.v2.decrypt(ciphertext, sharedKey)
    }
  }
}

// Encrypt a signaling message for a specific peer
export async function encryptSignal(
  message: object,
  recipientPubkey: string
): Promise<string | null> {
  const currentIdentity = get(identity)
  if (!currentIdentity) return null

  const plaintext = JSON.stringify(message)

  if (currentIdentity.isNip07) {
    // Use window.nostr NIP-44 if available
    if (window.nostr?.nip44) {
      return await window.nostr.nip44.encrypt(recipientPubkey, plaintext)
    }
    // Fall back to NIP-04 if NIP-44 not available
    if (window.nostr?.nip04) {
      return await window.nostr.nip04.encrypt(recipientPubkey, plaintext)
    }
    throw new Error('NIP-07 extension does not support encryption')
  }

  // Direct encryption with private key
  const signer = currentIdentity.signer as NDKPrivateKeySigner
  const privkey = signer.privateKey
  if (!privkey) throw new Error('No private key available')

  const conversationKey = nip44.v2.utils.getConversationKey(hexToBytes(privkey), recipientPubkey)
  return nip44.v2.encrypt(plaintext, conversationKey)
}

// Decrypt a signaling message from a peer
export async function decryptSignal(
  ciphertext: string,
  senderPubkey: string
): Promise<object | null> {
  const currentIdentity = get(identity)
  if (!currentIdentity) return null

  let plaintext: string

  if (currentIdentity.isNip07) {
    // Use window.nostr NIP-44 if available
    if (window.nostr?.nip44) {
      plaintext = await window.nostr.nip44.decrypt(senderPubkey, ciphertext)
    } else if (window.nostr?.nip04) {
      plaintext = await window.nostr.nip04.decrypt(senderPubkey, ciphertext)
    } else {
      throw new Error('NIP-07 extension does not support decryption')
    }
  } else {
    // Direct decryption with private key
    const signer = currentIdentity.signer as NDKPrivateKeySigner
    const privkey = signer.privateKey
    if (!privkey) throw new Error('No private key available')

    const conversationKey = nip44.v2.utils.getConversationKey(hexToBytes(privkey), senderPubkey)
    plaintext = nip44.v2.decrypt(ciphertext, conversationKey)
  }

  try {
    return JSON.parse(plaintext)
  } catch {
    console.error('Failed to parse decrypted signal')
    return null
  }
}
