<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import VideoTile from './VideoTile.svelte'
  import { participants, localMedia, focusedPubkey } from '../lib/webrtc'
  import { identity } from '../lib/identity'

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && $focusedPubkey) {
      focusedPubkey.set(null)
    }
  }

  onMount(() => {
    window.addEventListener('keydown', handleKeydown)
  })

  onDestroy(() => {
    window.removeEventListener('keydown', handleKeydown)
  })

  $: participantList = Array.from($participants.values())
  $: totalCount = participantList.length + 1 // +1 for local
  $: localPubkey = $identity?.pubkey || ''

  // Find focused participant data
  $: focusedParticipant = $focusedPubkey === localPubkey
    ? null // local user is focused
    : participantList.find(p => p.pubkey === $focusedPubkey)

  $: isLocalFocused = $focusedPubkey === localPubkey
  $: isFocusMode = $focusedPubkey !== null

  // Other participants (not focused) for the strip
  $: otherParticipants = isFocusMode
    ? participantList.filter(p => p.pubkey !== $focusedPubkey)
    : participantList

  // Calculate optimal columns for the participant count (grid mode)
  $: cols = totalCount === 1 ? 1
          : totalCount === 2 ? 2
          : totalCount <= 4 ? 2
          : totalCount <= 6 ? 3
          : totalCount <= 9 ? 3
          : 4

  // Calculate rows for grid sizing
  $: rows = Math.ceil(totalCount / cols)

  // Strip count (others + local if not focused)
  $: stripCount = isFocusMode
    ? (isLocalFocused ? otherParticipants.length : otherParticipants.length + 1)
    : 0

  function handleTileClick(pubkey: string) {
    if ($focusedPubkey === pubkey) {
      // Clicking focused tile unfocuses
      focusedPubkey.set(null)
    } else {
      focusedPubkey.set(pubkey)
    }
  }
</script>

{#if isFocusMode}
  <!-- Focus mode: large focused tile + small strip -->
  <div class="focus-layout">
    <!-- Focused tile -->
    <div class="focused-tile">
      {#if isLocalFocused}
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
      {:else if focusedParticipant}
        <VideoTile
          stream={focusedParticipant.stream}
          pubkey={focusedParticipant.pubkey}
          muted={false}
          mirrored={false}
          audioEnabled={focusedParticipant.audioEnabled}
          videoEnabled={focusedParticipant.videoEnabled}
          isLocal={false}
          on:click={() => handleTileClick(focusedParticipant.pubkey)}
        />
      {/if}
    </div>

    <!-- Strip of other participants -->
    {#if stripCount > 0}
      <div class="tile-strip" style="--strip-count: {stripCount};">
        {#if !isLocalFocused}
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
        {/if}
        {#each otherParticipants as participant (participant.pubkey)}
          <VideoTile
            stream={participant.stream}
            pubkey={participant.pubkey}
            muted={false}
            mirrored={false}
            audioEnabled={participant.audioEnabled}
            videoEnabled={participant.videoEnabled}
            isLocal={false}
            on:click={() => handleTileClick(participant.pubkey)}
          />
        {/each}
      </div>
    {/if}
  </div>
{:else}
  <!-- Grid mode: equal sized tiles -->
  <div
    class="video-grid"
    style="--cols: {cols}; --rows: {rows}; --total: {totalCount};"
  >
    <!-- Local video -->
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

    <!-- Remote participants -->
    {#each participantList as participant (participant.pubkey)}
      <VideoTile
        stream={participant.stream}
        pubkey={participant.pubkey}
        muted={false}
        mirrored={false}
        audioEnabled={participant.audioEnabled}
        videoEnabled={participant.videoEnabled}
        isLocal={false}
        on:click={() => handleTileClick(participant.pubkey)}
      />
    {/each}
  </div>
{/if}

<style>
  /* Grid mode styles */
  .video-grid {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    align-content: center;
    gap: 1rem;
    width: 100%;
    height: 100%;
    padding: 1rem;
    padding-top: calc(1rem + env(safe-area-inset-top, 0px));
    padding-bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
    padding-left: calc(1rem + env(safe-area-inset-left, 0px));
    padding-right: calc(1rem + env(safe-area-inset-right, 0px));
    overflow: hidden;
    box-sizing: border-box;
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

  /* Focus mode styles */
  .focus-layout {
    display: flex;
    flex-direction: column;
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

  /* Mobile: smaller strip tiles */
  @media (max-width: 639px) {
    .tile-strip > :global(*) {
      width: 120px;
      height: 68px;
    }
  }
</style>
