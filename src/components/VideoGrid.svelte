<script lang="ts">
  import VideoTile from './VideoTile.svelte'
  import { participants, localMedia } from '../lib/webrtc'
  import { identity } from '../lib/identity'

  $: participantList = Array.from($participants.values())
  $: totalCount = participantList.length + 1 // +1 for local

  // Calculate optimal columns for the participant count
  $: cols = totalCount === 1 ? 1
          : totalCount === 2 ? 2
          : totalCount <= 4 ? 2
          : totalCount <= 6 ? 3
          : totalCount <= 9 ? 3
          : 4

  // Calculate rows for grid sizing
  $: rows = Math.ceil(totalCount / cols)
</script>

<div
  class="video-grid"
  style="--cols: {cols}; --rows: {rows}; --total: {totalCount};"
>
  <!-- Local video -->
  <VideoTile
    stream={$localMedia.screenSharing ? $localMedia.screenStream : $localMedia.stream}
    pubkey={$identity?.pubkey || ''}
    muted={true}
    mirrored={!$localMedia.screenSharing}
    audioEnabled={$localMedia.audioEnabled}
    videoEnabled={$localMedia.videoEnabled || $localMedia.screenSharing}
    isLocal={true}
    isScreenShare={$localMedia.screenSharing}
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
    />
  {/each}
</div>

<style>
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

  /* Size tiles based on columns/rows while fitting container */
  .video-grid > :global(*) {
    width: calc((100% - (var(--cols) - 1) * 1rem) / var(--cols));
    max-height: calc((100% - (var(--rows) - 1) * 1rem) / var(--rows));
  }

  /* Mobile: single column, rows = total count */
  @media (max-width: 639px) {
    .video-grid > :global(*) {
      width: 100%;
      max-height: calc((100% - (var(--total) - 1) * 1rem) / var(--total));
    }
  }
</style>
