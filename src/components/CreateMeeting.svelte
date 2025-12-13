<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import { createMeeting, type Meeting } from '../lib/meeting'

  const dispatch = createEventDispatcher()

  function handleCreate() {
    const meeting = createMeeting()
    dispatch('join', { meeting })
  }
</script>

<div class="w-full max-w-md mx-auto p-6 bg-surface rounded-2xl shadow-xl">
  <h2 class="text-2xl font-bold text-white mb-4 text-center">Start a Meeting</h2>
  <p class="text-gray-400 text-center mb-6">
    Create a new meeting room and invite others to join.
  </p>

  <button
    class="btn-primary w-full flex items-center justify-center gap-2"
    on:click={handleCreate}
  >
    <span class="i-carbon-video-add"></span>
    Start Meeting
  </button>
</div>
