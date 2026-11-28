<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import VideoTile from './VideoTile.svelte'
  import { participants, localMedia, focusedPubkey, type Participant } from '../lib/meetingSession'
  import { identity } from '../lib/identity'

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && $focusedPubkey) focusedPubkey.set(null)
  }

  onMount(() => { window.addEventListener('keydown', handleKeydown) })
  onDestroy(() => { window.removeEventListener('keydown', handleKeydown) })

  $: participantList = Array.from($participants.values())
  $: totalCount = participantList.length + 1
  $: localPubkey = $identity?.pubkey || ''
  $: isLocalFocused = $focusedPubkey === localPubkey
  $: focusedParticipant = isLocalFocused ? null : participantList.find(p => p.pubkey === $focusedPubkey)
  $: isFocusMode = isLocalFocused || !!focusedParticipant
  $: otherParticipants = isFocusMode ? participantList.filter(p => p.pubkey !== $focusedPubkey) : participantList

  $: cols = totalCount === 1 ? 1
          : totalCount <= 4 ? 2
          : totalCount <= 9 ? 3
          : 4
  $: rows = Math.ceil(totalCount / cols)
  $: stripCount = isFocusMode ? (isLocalFocused ? otherParticipants.length : otherParticipants.length + 1) : 0

  function handleTileClick(pubkey: string) {
    focusedPubkey.set($focusedPubkey === pubkey ? null : pubkey)
  }
</script>

{#snippet localTile()}
  <VideoTile
    stream={$localMedia.screenSharing ? $localMedia.screenStream : $localMedia.stream}
    pubkey={localPubkey}
    muted={true}
    mirrored={!$localMedia.screenSharing}
    audioEnabled={$localMedia.audioEnabled}
    videoEnabled={$localMedia.videoEnabled || $localMedia.screenSharing}
    isLocal={true}
    isScreenShare={$localMedia.screenSharing}
    on:click={() => handleTileClick(localPubkey)}
  />
{/snippet}

{#snippet remoteTile(participant: Participant)}
  <VideoTile
    stream={participant.stream}
    pubkey={participant.pubkey}
    muted={false}
    mirrored={false}
    audioEnabled={participant.audioEnabled}
    videoEnabled={participant.videoEnabled || participant.screenSharing}
    isScreenShare={participant.screenSharing}
    connectionState={participant.connectionState}
    isLocal={false}
    on:click={() => handleTileClick(participant.pubkey)}
  />
{/snippet}

{#if isFocusMode}
  <div class="focus-layout">
    <div class="focused-tile">
      {#if isLocalFocused}
        {@render localTile()}
      {:else if focusedParticipant}
        {@render remoteTile(focusedParticipant)}
      {/if}
    </div>

    {#if stripCount > 0}
      <div class="tile-strip" style="--strip-count: {stripCount};">
        {#if !isLocalFocused}
          {@render localTile()}
        {/if}
        {#each otherParticipants as participant (participant.pubkey)}
          {@render remoteTile(participant)}
        {/each}
      </div>
    {/if}
  </div>
{:else}
  <div class="video-grid" style="--cols: {cols}; --rows: {rows}; --total: {totalCount};">
    {@render localTile()}
    {#each participantList as participant (participant.pubkey)}
      {@render remoteTile(participant)}
    {/each}
  </div>
{/if}

<style>
  .video-grid,
  .focus-layout {
    display: flex;
    width: 100%;
    height: 100%;
    padding: 1rem;
    padding-top: calc(1rem + env(safe-area-inset-top, 0px));
    padding-bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
    padding-left: calc(1rem + env(safe-area-inset-left, 0px));
    padding-right: calc(1rem + env(safe-area-inset-right, 0px));
    gap: 1rem;
    overflow: hidden;
    box-sizing: border-box;
  }

  .video-grid {
    flex-wrap: wrap;
    justify-content: center;
    align-content: center;
  }

  .video-grid > :global(*) {
    width: calc((100% - (var(--cols) - 1) * 1rem) / var(--cols));
    max-height: calc((100% - (var(--rows) - 1) * 1rem) / var(--rows));
  }

  @media (max-width: 639px) {
    .video-grid > :global(*) {
      width: 100%;
      max-height: calc((100% - (var(--total) - 1) * 1rem) / var(--total));
    }
  }

  .focus-layout {
    flex-direction: column;
  }

  .focused-tile {
    flex: 1;
    min-height: 0;
    display: flex;
    justify-content: center;
    align-items: center;
  }

  .focused-tile > :global(*) {
    max-width: 100%;
    max-height: 100%;
  }

  .tile-strip {
    flex-shrink: 0;
    display: flex;
    gap: 0.5rem;
    justify-content: center;
    overflow-x: auto;
    padding-bottom: 0.25rem;
  }

  .tile-strip > :global(*) {
    flex-shrink: 0;
    width: 160px;
    height: 90px;
  }

  @media (max-width: 639px) {
    .tile-strip > :global(*) {
      width: 120px;
      height: 68px;
    }
  }
</style>
