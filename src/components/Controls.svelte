<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte'
  import { localMedia, toggleAudio, toggleVideo, toggleScreenShare, getMediaDevices, switchCamera, switchMicrophone, unreadCount } from '../lib/webrtc'

  const dispatch = createEventDispatcher()

  export let showCopyLink: boolean = false
  export let copied: boolean = false

  let audioDevices: MediaDeviceInfo[] = []
  let videoDevices: MediaDeviceInfo[] = []
  let showAudioMenu = false
  let showVideoMenu = false

  onMount(async () => {
    await loadDevices()
  })

  async function loadDevices() {
    const devices = await getMediaDevices()
    audioDevices = devices.audioInputs
    videoDevices = devices.videoInputs
  }

  function handleToggleAudio() {
    toggleAudio()
  }

  function handleToggleVideo() {
    toggleVideo()
  }

  async function handleToggleScreenShare() {
    await toggleScreenShare()
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

  async function selectAudioDevice(deviceId: string) {
    await switchMicrophone(deviceId)
    showAudioMenu = false
  }

  async function selectVideoDevice(deviceId: string) {
    await switchCamera(deviceId)
    showVideoMenu = false
  }

  function closeMenus() {
    showAudioMenu = false
    showVideoMenu = false
  }
</script>

<!-- Backdrop to close menus -->
{#if showAudioMenu || showVideoMenu}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="fixed inset-0 z-40" on:click={closeMenus}></div>
{/if}

<div class="fixed bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/80 to-transparent z-50">
  <div class="flex items-center justify-center gap-3">
    <!-- Audio toggle with menu -->
    <div class="relative flex">
      {#if audioDevices.length > 1}
        <button
          class="w-8 h-12 rounded-l-full flex items-center justify-center pl-2 pr-0 transition-colors border-r border-white/20"
          class:bg-surface-light={$localMedia.audioEnabled}
          class:hover:bg-surface-lighter={$localMedia.audioEnabled}
          class:bg-red-600={!$localMedia.audioEnabled}
          class:hover:bg-red-700={!$localMedia.audioEnabled}
          on:click={() => { showAudioMenu = !showAudioMenu; showVideoMenu = false }}
          title="Select microphone"
        >
          <span class="i-carbon-chevron-up text-sm text-white"></span>
        </button>
      {/if}
      <button
        class="w-12 h-12 rounded-full flex items-center justify-center transition-colors {audioDevices.length > 1 ? 'rounded-l-none' : ''}"
        class:bg-surface-light={$localMedia.audioEnabled}
        class:hover:bg-surface-lighter={$localMedia.audioEnabled}
        class:bg-red-600={!$localMedia.audioEnabled}
        class:hover:bg-red-700={!$localMedia.audioEnabled}
        on:click={handleToggleAudio}
        title={$localMedia.audioEnabled ? 'Mute microphone (Ctrl+D)' : 'Unmute microphone (Ctrl+D)'}
      >
        {#if $localMedia.audioEnabled}
          <span class="i-carbon-microphone text-xl text-white"></span>
        {:else}
          <span class="i-carbon-microphone-off text-xl text-white"></span>
        {/if}
      </button>

      <!-- Audio device menu -->
      {#if showAudioMenu}
        <div class="absolute bottom-full mb-2 left-0 bg-surface border border-surface-lighter rounded-lg shadow-xl py-1 min-w-56 max-w-72 z-50">
          <div class="px-3 py-1 text-xs text-gray-400 uppercase">Microphone</div>
          {#each audioDevices as device}
            <button
              class="w-full px-3 py-2 text-sm text-left text-white flex items-center gap-2 {device.deviceId === $localMedia.audioDeviceId ? 'bg-primary/20 hover:bg-primary/30' : 'hover:bg-surface-lighter'}"
              on:click={() => selectAudioDevice(device.deviceId)}
            >
              <span class="i-carbon-microphone text-gray-400 flex-shrink-0"></span>
              <span class="truncate">{device.label || `Microphone ${audioDevices.indexOf(device) + 1}`}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Video toggle with menu -->
    <div class="relative flex">
      {#if videoDevices.length > 1}
        <button
          class="w-8 h-12 rounded-l-full flex items-center justify-center pl-2 pr-0 transition-colors border-r border-white/20"
          class:bg-surface-light={$localMedia.videoEnabled}
          class:hover:bg-surface-lighter={$localMedia.videoEnabled}
          class:bg-red-600={!$localMedia.videoEnabled}
          class:hover:bg-red-700={!$localMedia.videoEnabled}
          on:click={() => { showVideoMenu = !showVideoMenu; showAudioMenu = false }}
          title="Select camera"
        >
          <span class="i-carbon-chevron-up text-sm text-white"></span>
        </button>
      {/if}
      <button
        class="w-12 h-12 rounded-full flex items-center justify-center transition-colors {videoDevices.length > 1 ? 'rounded-l-none' : ''}"
        class:bg-surface-light={$localMedia.videoEnabled}
        class:hover:bg-surface-lighter={$localMedia.videoEnabled}
        class:bg-red-600={!$localMedia.videoEnabled}
        class:hover:bg-red-700={!$localMedia.videoEnabled}
        on:click={handleToggleVideo}
        title={$localMedia.videoEnabled ? 'Turn off camera (Ctrl+E)' : 'Turn on camera (Ctrl+E)'}
      >
        {#if $localMedia.videoEnabled}
          <span class="i-carbon-video text-xl text-white"></span>
        {:else}
          <span class="i-carbon-video-off text-xl text-white"></span>
        {/if}
      </button>

      <!-- Video device menu -->
      {#if showVideoMenu}
        <div class="absolute bottom-full mb-2 left-0 bg-surface border border-surface-lighter rounded-lg shadow-xl py-1 min-w-56 max-w-72 z-50">
          <div class="px-3 py-1 text-xs text-gray-400 uppercase">Camera</div>
          {#each videoDevices as device}
            <button
              class="w-full px-3 py-2 text-sm text-left text-white flex items-center gap-2 {device.deviceId === $localMedia.videoDeviceId ? 'bg-primary/20 hover:bg-primary/30' : 'hover:bg-surface-lighter'}"
              on:click={() => selectVideoDevice(device.deviceId)}
            >
              <span class="i-carbon-video text-gray-400 flex-shrink-0"></span>
              <span class="truncate">{device.label || `Camera ${videoDevices.indexOf(device) + 1}`}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Screen share button -->
    <button
      class="w-12 h-12 rounded-full flex items-center justify-center transition-colors"
      class:bg-primary={$localMedia.screenSharing}
      class:hover:bg-primary-dark={$localMedia.screenSharing}
      class:bg-surface-light={!$localMedia.screenSharing}
      class:hover:bg-surface-lighter={!$localMedia.screenSharing}
      on:click={handleToggleScreenShare}
      title={$localMedia.screenSharing ? 'Stop sharing' : 'Share screen'}
    >
      <span class="i-carbon-screen text-xl text-white"></span>
    </button>

    <!-- Copy link button -->
    {#if showCopyLink}
      <button
        class="w-12 h-12 rounded-full flex items-center justify-center transition-colors"
        class:bg-green-600={copied}
        class:bg-surface-light={!copied}
        class:hover:bg-surface-lighter={!copied}
        on:click={handleCopyLink}
        title={copied ? 'Copied!' : 'Copy meeting link'}
      >
        {#if copied}
          <span class="i-carbon-checkmark text-xl text-white"></span>
        {:else}
          <span class="i-carbon-link text-xl text-white"></span>
        {/if}
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
