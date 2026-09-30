import type { Nip07LikeSigner } from '@iris/identity/signers'
declare global {
  interface Window {
    nostr?: Nip07LikeSigner & {
      nip04?: { encrypt(pubkey: string, plaintext: string): Promise<string>; decrypt(pubkey: string, ciphertext: string): Promise<string> }
    }
  }
}
