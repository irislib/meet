import { nip44, getPublicKey } from 'nostr-tools'
import { get } from 'svelte/store'
import { identity } from './identity'

// Helper function
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

export interface MeetingEncryption {
  roomPubkey: string
  encrypt: (plaintext: string) => string
  decrypt: (ciphertext: string) => string
}

export function createMeetingEncryption(roomPrivkeyHex: string): MeetingEncryption {
  const roomPubkey = getPublicKey(hexToBytes(roomPrivkeyHex))
  // Use room's own key pair for symmetric-like encryption
  // Everyone encrypts TO the room pubkey using the room privkey (shared secret)
  const sharedKey = nip44.v2.utils.getConversationKey(hexToBytes(roomPrivkeyHex), roomPubkey)

  return {
    roomPubkey,

    // Encrypt message using shared room key
    encrypt(plaintext: string): string {
      return nip44.v2.encrypt(plaintext, sharedKey)
    },

    // Decrypt message using shared room key
    decrypt(ciphertext: string): string {
      return nip44.v2.decrypt(ciphertext, sharedKey)
    }
  }
}

// Identity encryption uses the shared signer, including extension-managed keys.
export async function encryptForPeer(data: unknown, recipientPubkey: string): Promise<string | null> {
  const current = get(identity)
  if (!current) return null
  const plaintext = JSON.stringify(data)
  if (current.signer.nip44Encrypt) return current.signer.nip44Encrypt(recipientPubkey, plaintext)
  if (current.isNip07 && window.nostr?.nip04) return window.nostr.nip04.encrypt(recipientPubkey, plaintext)
  throw new Error('Your signer does not support encryption')
}

export async function decryptFromPeer(ciphertext: string, senderPubkey: string): Promise<any | null> {
  const current = get(identity)
  if (!current) return null
  const plaintext = current.signer.nip44Decrypt
    ? await current.signer.nip44Decrypt(senderPubkey, ciphertext)
    : current.isNip07 && window.nostr?.nip04
      ? await window.nostr.nip04.decrypt(senderPubkey, ciphertext)
      : null
  if (plaintext === null) throw new Error('Your signer does not support decryption')
  try { return JSON.parse(plaintext) } catch { return null }
}
