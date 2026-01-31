<script lang="ts">
  import { onDestroy, createEventDispatcher } from 'svelte'
  import Avatar from './Avatar.svelte'
  import Name from './Name.svelte'
  import { localMedia, type ConnectionState } from '../lib/webrtc'

  export let stream: MediaStream | null = null
  export let pubkey: string = ''
  export let muted: boolean = false
  export let mirrored: boolean = false
  export let audioEnabled: boolean = true
  export let videoEnabled: boolean = true
  export let isLocal: boolean = false
  export let isScreenShare: boolean = false
  export let connectionState: ConnectionState = 'connected'

  const dispatch = createEventDispatcher<{ click: { pubkey: string } }>()

  let videoElement: HTMLVideoElement

  function handleClick() {
    dispatch('click', { pubkey })
  }

  $: if (videoElement && stream) {
    videoElement.srcObject = stream
  }

  // Apply audio output device (setSinkId) to remote video elements
  $: if (videoElement && !isLocal && $localMedia.audioOutputDeviceId) {
    const el = videoElement as any
    if (typeof el.setSinkId === 'function') {
      el.setSinkId($localMedia.audioOutputDeviceId).catch((err: Error) => {
        console.warn('Failed to set audio output device:', err)
      })
    }
  }

  onDestroy(() => {
    if (videoElement) {
      videoElement.srcObject = null
    }
  })
</script>

<div
  class="relative bg-surface-light rounded-xl overflow-hidden w-full aspect-video cursor-pointer hover:ring-2 hover:ring-primary/50 transition-shadow"
  data-testid="video-tile"
  on:click={handleClick}
  on:keydown={(e) => e.key === 'Enter' && handleClick()}
  role="button"
  tabindex="0"
>
  {#if stream && videoEnabled}
    <video
      bind:this={videoElement}
      autoplay
      playsinline
      {muted}
      class="w-full h-full"
      class:object-cover={!isScreenShare}
      class:object-contain={isScreenShare}
      class:scale-x-[-1]={mirrored}
    ></video>
  {:else}
    <div class="w-full h-full flex items-center justify-center bg-surface">
      <Avatar {pubkey} size={80} />
    </div>
  {/if}

  <!-- Name badge -->
  <div class="absolute bottom-2 left-2 px-2 py-1 bg-black/60 rounded-md text-sm text-white flex items-center gap-2">
    {#if !audioEnabled}
      <span class="i-carbon-microphone-off text-red-500"></span>
    {/if}
    {#if isScreenShare}
      <span class="i-carbon-screen text-primary"></span>
    {/if}
    <Avatar {pubkey} size={20} />
    <Name {pubkey} />
    {#if isLocal}
      <span class="text-xs text-gray-400">(You)</span>
    {/if}
  </div>

  <!-- Video off indicator -->
  {#if !videoEnabled && !isScreenShare}
    <div class="absolute top-2 right-2 p-1 bg-black/60 rounded-md">
      <span class="i-carbon-video-off text-red-500"></span>
    </div>
  {/if}

  <!-- Connection state overlay -->
  {#if !isLocal && connectionState === 'connecting'}
    <div class="absolute inset-0 bg-black/40 flex items-center justify-center">
      <div class="text-center">
        <div class="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
        <span class="text-sm text-white">Connecting...</span>
      </div>
    </div>
  {:else if !isLocal && connectionState === 'failed'}
    <div class="absolute inset-0 bg-black/40 flex items-center justify-center">
      <div class="text-center">
        <span class="i-carbon-warning text-2xl text-red-500 mb-2"></span>
        <span class="text-sm text-white block">Connection failed</span>
      </div>
    </div>
  {/if}
</div>
