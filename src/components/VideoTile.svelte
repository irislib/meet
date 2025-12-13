<script lang="ts">
  import { onDestroy } from 'svelte'
  import Avatar from './Avatar.svelte'
  import Name from './Name.svelte'

  export let stream: MediaStream | null = null
  export let pubkey: string = ''
  export let muted: boolean = false
  export let mirrored: boolean = false
  export let audioEnabled: boolean = true
  export let videoEnabled: boolean = true
  export let isLocal: boolean = false
  export let isScreenShare: boolean = false

  let videoElement: HTMLVideoElement

  $: if (videoElement && stream) {
    videoElement.srcObject = stream
  }

  onDestroy(() => {
    if (videoElement) {
      videoElement.srcObject = null
    }
  })
</script>

<div class="relative bg-surface-light rounded-xl overflow-hidden aspect-video" data-testid="video-tile">
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
</div>
