import { requestBrowserSigner, restoreBrowserSigner, isBrowserSignerSession, type BrowserSignerSession } from '@iris/identity/browserSigner'
import { createNostrIdentitySignerFromSecretKey, createNostrIdentitySignerFromNip07, type NostrIdentityEventSigner } from '@iris/identity/signers'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'
import { writable, get } from 'svelte/store'
import { setNostrSigner } from './nostr'
import { saveLocalProfile, clearLocalProfile, getLocalProfile } from './profile'

export interface Identity {
  pubkey: string
  signer: NostrIdentityEventSigner
  displayName: string | null
  isNip07: boolean
  canCopySecretKey: boolean
}

const IDENTITY_STORAGE_KEY = 'iris-meet-identity'

export const identity = writable<Identity | null>(null)

export function generateNewIdentity(): { privkey: string; pubkey: string; nsec: string } {
  const privkeyBytes = generateSecretKey()
  return {
    privkey: bytesToHex(privkeyBytes),
    pubkey: getPublicKey(privkeyBytes),
    nsec: nip19.nsecEncode(privkeyBytes),
  }
}

export function loadStoredIdentity(): string | null {
  try { return localStorage.getItem(IDENTITY_STORAGE_KEY) } catch { return null }
}

export function saveIdentity(privkeyHex: string): boolean {
  try { localStorage.setItem(IDENTITY_STORAGE_KEY, privkeyHex); return true }
  catch { console.warn('Failed to save identity to localStorage'); return false }
}

export function getLocalProfileNsec(pubkey: string): string | null {
  const current = get(identity)
  if (!current?.canCopySecretKey || current.pubkey !== pubkey) return null
  const stored = loadStoredIdentity()
  if (!stored || !/^[0-9a-f]{64}$/i.test(stored)) return null
  const bytes = hexToBytes(stored)
  try {
    return getPublicKey(bytes) === pubkey ? nip19.nsecEncode(bytes) : null
  } catch {
    return null
  } finally {
    bytes.fill(0)
  }
}

export function clearStoredIdentity(): void {
  try { localStorage.removeItem(IDENTITY_STORAGE_KEY) }
  catch { console.warn('Failed to clear identity from localStorage') }
}

function activateIdentity(next: Identity) {
  setNostrSigner(next.signer)
  identity.set(next)
  if (next.displayName) saveLocalProfile(next.pubkey, next.displayName)
}

export async function loginWithPrivkey(privkeyHex: string, displayName: string | null = null): Promise<void> {
  const signer = createNostrIdentitySignerFromSecretKey(hexToBytes(privkeyHex))
  const pubkey = await signer.getPublicKey()
  activateIdentity({ pubkey, signer, displayName, isNip07: false, canCopySecretKey: saveIdentity(privkeyHex) })
}

function activateRemoteSigner(session: BrowserSignerSession, displayName: string | null): void {
  activateIdentity({ pubkey: session.pubkey, signer: restoreBrowserSigner(session), displayName, isNip07: false, canCopySecretKey: false })
}

export async function loginWithRemoteSigner(displayName: string | null): Promise<boolean> {
  const session = await requestBrowserSigner({ name: 'Iris Meet', permissions: 'sign_event,nip44_encrypt,nip44_decrypt' })
  if (!session) return false
  activateRemoteSigner(session, displayName)
  saveIdentity(JSON.stringify(session))
  return true
}

export async function loginWithNip07(displayName: string | null = null): Promise<void> {
  if (!window.nostr) throw new Error('No NIP-07 extension found')
  const signer = createNostrIdentitySignerFromNip07(window.nostr)
  const pubkey = await signer.getPublicKey()
  setNostrSigner(signer)
  identity.set({ pubkey, signer, displayName, isNip07: true, canCopySecretKey: false })
  saveIdentity('nip07')
}

export async function autoLogin(displayName: string | null = null): Promise<boolean> {
  // Check stored user identity (URL hash holds the meeting key, not the user identity).
  const storedValue = loadStoredIdentity()
  if (!storedValue) return false
  if (!displayName) {
    const localProfile = getLocalProfile()
    displayName = localProfile?.display_name || localProfile?.name || null
  }
  if (storedValue.startsWith('{')) {
    try {
      const session: unknown = JSON.parse(storedValue)
      if (isBrowserSignerSession(session)) {
        activateRemoteSigner(session, displayName)
        return true
      }
    } catch { /* Reopen account selection when the stored session is invalid. */ }
    clearStoredIdentity()
    return false
  }
  if (storedValue === 'nip07') {
    if (hasNip07()) {
      try { await loginWithNip07(displayName); return true } catch { /* Extension denied or removed. */ }
    }
    clearStoredIdentity()
    return false
  }
  await loginWithPrivkey(storedValue, displayName)
  return true
}

export function logout(): void {
  const pubkey = get(identity)?.pubkey
  setNostrSigner(undefined)
  identity.set(null)
  clearStoredIdentity()
  clearLocalProfile(pubkey)
}

export function hasNip07(): boolean {
  return typeof window !== 'undefined' && !!window.nostr
}
