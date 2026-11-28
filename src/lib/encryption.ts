import { nip44, getPublicKey } from 'nostr-tools'
import { hexToBytes } from 'nostr-tools/utils'
import { get } from 'svelte/store'
import { identity } from './identity'

export interface MeetingEncryption {
  roomPubkey: string
  encrypt: (plaintext: string) => string
  decrypt: (ciphertext: string) => string
}

export function createMeetingEncryption(roomPrivkeyHex: string): MeetingEncryption {
  const privkeyBytes = hexToBytes(roomPrivkeyHex)
  const roomPubkey = getPublicKey(privkeyBytes)
  // Everyone encrypts to the room pubkey using the shared room secret.
  const sharedKey = nip44.v2.utils.getConversationKey(privkeyBytes, roomPubkey)

  return {
    roomPubkey,
    encrypt: (plaintext: string) => nip44.v2.encrypt(plaintext, sharedKey),
    decrypt: (ciphertext: string) => nip44.v2.decrypt(ciphertext, sharedKey),
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
