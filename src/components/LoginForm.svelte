<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte'
  import { hasNip07, loginWithRemoteSigner, loginWithNip07, loginWithPrivkey, generateNewIdentity } from '../lib/identity'
  import { isInMeeting } from '../lib/meeting'

  const dispatch = createEventDispatcher()

  let displayName = ''
  let existing = false
  let loading = false
  let error = ''
  let inputEl: HTMLInputElement

  const supportsNip07 = hasNip07()
  const hasMeetingInUrl = isInMeeting()

  onMount(() => {
    // Autofocus on non-touch devices
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0
    if (!isTouchDevice && inputEl) {
      inputEl.focus()
    }
  })

  async function handleNip07Login() {
    loading = true
    error = ''
    try {
      await loginWithNip07(displayName || null)
      dispatch('login')
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to login with extension'
    } finally {
      loading = false
    }
  }

  async function handleRemoteLogin() {
    loading = true
    error = ''
    try {
      if (await loginWithRemoteSigner(displayName || null)) dispatch('login')
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not sign in with your signer'
    } finally {
      loading = false
    }
  }

  async function handleGenerateIdentity() {
    loading = true
    error = ''
    try {
      const { privkey } = generateNewIdentity()
      await loginWithPrivkey(privkey, displayName || null)
      dispatch('login')
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to generate identity'
    } finally {
      loading = false
    }
  }
</script>

<div class="w-full max-w-md mx-auto p-6 bg-surface rounded-2xl shadow-xl">
  <div class="space-y-4">
    <!-- Display name input -->
    <div>
      <label for="displayName" class="block text-sm text-gray-400 mb-1">
        Your name (optional)
      </label>
      <input
        id="displayName"
        type="text"
        bind:this={inputEl}
        bind:value={displayName}
        placeholder="Name"
        class="input-field"
        disabled={loading}
        on:keydown={(e) => e.key === 'Enter' && !existing && handleGenerateIdentity()}
      />
    </div>

    {#if error}
      <div class="p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-400 text-sm">
        {error}
      </div>
    {/if}

    <!-- Login options -->
    <div class="space-y-3 pt-2">
      {#if existing}
        <button class="btn-primary w-full" on:click={handleRemoteLogin} disabled={loading}>Sign in with remote signer</button>
        {#if supportsNip07}
          <button class="btn-secondary w-full" on:click={handleNip07Login} disabled={loading}>Login with Extension</button>
        {/if}
        <button class="btn-ghost w-full" on:click={() => existing = false} disabled={loading}>Back</button>
      {:else}
        <button class="btn-primary w-full" on:click={handleGenerateIdentity} disabled={loading}>
          {hasMeetingInUrl ? 'Join Meeting' : 'Join'}
        </button>
        <button class="btn-secondary w-full" on:click={() => existing = true} disabled={loading}>Already have an account?</button>
      {/if}
    </div>
  </div>
</div>
