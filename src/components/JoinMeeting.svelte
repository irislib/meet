<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import { parseMeetingInput, type Meeting } from '../lib/meeting'

  const dispatch = createEventDispatcher<{ join: { meeting: Meeting } }>()

  let meetingInput = ''
  let error = ''

  function handleJoin() {
    error = ''
    const meeting = parseMeetingInput(meetingInput)
    if (!meeting) {
      error = 'Please enter a valid meeting link'
      return
    }
    dispatch('join', { meeting })
  }

  // Auto-join when a valid link or secret is pasted.
  $: {
    const meeting = parseMeetingInput(meetingInput)
    if (meeting) dispatch('join', { meeting })
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
