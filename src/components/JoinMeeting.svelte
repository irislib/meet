<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import { parseMeetingFromHash, type Meeting } from '../lib/meeting'
  import { getPublicKey } from 'nostr-tools'

  const dispatch = createEventDispatcher()

  let meetingInput = ''
  let error = ''

  function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    }
    return bytes
  }

  function extractPrivkeyHex(input: string): string | null {
    let privkeyHex = input.trim()

    // If it's a URL, extract the hash
    if (privkeyHex.includes('#')) {
      privkeyHex = privkeyHex.split('#')[1] || ''
    }

    // Validate hex format (64 chars for 32 bytes)
    if (/^[0-9a-fA-F]{64}$/.test(privkeyHex)) {
      return privkeyHex
    }
    return null
  }

  function joinWithPrivkey(privkeyHex: string) {
    try {
      const privkeyBytes = hexToBytes(privkeyHex)
      const pubkey = getPublicKey(privkeyBytes)

      const meeting: Meeting = {
        id: pubkey.slice(0, 12),
        privkeyHex,
        pubkey,
        createdAt: new Date(),
      }

      dispatch('join', { meeting })
    } catch (e) {
      error = 'Invalid meeting link'
    }
  }

  function handleJoin() {
    error = ''
    const privkeyHex = extractPrivkeyHex(meetingInput)
    if (!privkeyHex) {
      error = 'Please enter a valid meeting link'
      return
    }
    joinWithPrivkey(privkeyHex)
  }

  // Auto-join when valid link is pasted
  $: {
    const privkeyHex = extractPrivkeyHex(meetingInput)
    if (privkeyHex) {
      joinWithPrivkey(privkeyHex)
    }
  }

  // Check URL hash on mount
  $: {
    const hashMeeting = parseMeetingFromHash()
    if (hashMeeting) {
      dispatch('join', { meeting: hashMeeting })
    }
  }
</script>

<div class="w-full max-w-md mx-auto p-6 bg-surface rounded-2xl shadow-xl">
  <h2 class="text-2xl font-bold text-white mb-4 text-center">Join a Meeting</h2>

  <div class="space-y-4">
    <div>
      <label for="meetingInput" class="block text-sm text-gray-400 mb-1">
        Meeting Link
      </label>
      <input
        id="meetingInput"
        type="text"
        bind:value={meetingInput}
        placeholder="Paste meeting link"
        class="input-field"
        on:keydown={(e) => e.key === 'Enter' && handleJoin()}
      />
    </div>

    {#if error}
      <div class="p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-400 text-sm">
        {error}
      </div>
    {/if}

    <button
      class="btn-primary w-full flex items-center justify-center gap-2"
      on:click={handleJoin}
      disabled={!meetingInput.trim()}
    >
      <span class="i-carbon-login"></span>
      Join Meeting
    </button>
  </div>
</div>
