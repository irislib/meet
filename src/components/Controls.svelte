<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import { localMedia, toggleAudio, toggleVideo, unreadCount } from '../lib/webrtc'

  const dispatch = createEventDispatcher()

  export let showCopyLink: boolean = false

  function handleToggleAudio() {
    toggleAudio()
  }

  function handleToggleVideo() {
    toggleVideo()
  }

  function handleLeave() {
    dispatch('leave')
  }

  function handleCopyLink() {
    dispatch('copyLink')
  }

  function handleToggleChat() {
    dispatch('toggleChat')
  }
</script>

<div class="fixed bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/80 to-transparent">
  <div class="flex items-center justify-center gap-4">
    <!-- Audio toggle -->
    <button
      class="w-12 h-12 rounded-full flex items-center justify-center transition-colors"
      class:bg-surface-light={$localMedia.audioEnabled}
      class:hover:bg-surface-lighter={$localMedia.audioEnabled}
      class:bg-red-600={!$localMedia.audioEnabled}
      class:hover:bg-red-700={!$localMedia.audioEnabled}
      on:click={handleToggleAudio}
      title={$localMedia.audioEnabled ? 'Mute microphone' : 'Unmute microphone'}
    >
      {#if $localMedia.audioEnabled}
        <span class="i-carbon-microphone text-xl text-white"></span>
      {:else}
        <span class="i-carbon-microphone-off text-xl text-white"></span>
      {/if}
    </button>

    <!-- Video toggle -->
    <button
      class="w-12 h-12 rounded-full flex items-center justify-center transition-colors"
      class:bg-surface-light={$localMedia.videoEnabled}
      class:hover:bg-surface-lighter={$localMedia.videoEnabled}
      class:bg-red-600={!$localMedia.videoEnabled}
      class:hover:bg-red-700={!$localMedia.videoEnabled}
      on:click={handleToggleVideo}
      title={$localMedia.videoEnabled ? 'Turn off camera' : 'Turn on camera'}
    >
      {#if $localMedia.videoEnabled}
        <span class="i-carbon-video text-xl text-white"></span>
      {:else}
        <span class="i-carbon-video-off text-xl text-white"></span>
      {/if}
    </button>

    <!-- Copy link button -->
    {#if showCopyLink}
      <button
        class="w-12 h-12 rounded-full bg-surface-light hover:bg-surface-lighter flex items-center justify-center transition-colors"
        on:click={handleCopyLink}
        title="Copy meeting link"
      >
        <span class="i-carbon-link text-xl text-white"></span>
      </button>
    {/if}

    <!-- Chat button -->
    <button
      class="w-12 h-12 rounded-full bg-surface-light hover:bg-surface-lighter flex items-center justify-center transition-colors relative"
      on:click={handleToggleChat}
      title="Open chat"
    >
      <span class="i-carbon-chat text-xl text-white"></span>
      {#if $unreadCount > 0}
        <span class="absolute -top-1 -right-1 w-5 h-5 bg-red-500 rounded-full text-xs text-white flex items-center justify-center">
          {$unreadCount > 9 ? '9+' : $unreadCount}
        </span>
      {/if}
    </button>

    <!-- Leave button -->
    <button
      class="w-12 h-12 rounded-full bg-red-600 hover:bg-red-700 flex items-center justify-center transition-colors"
      on:click={handleLeave}
      title="Leave meeting"
    >
      <span class="i-carbon-phone-off text-xl text-white"></span>
    </button>
  </div>
</div>
