<script lang="ts">
  import VideoTile from './VideoTile.svelte'
  import { participants, localMedia } from '../lib/webrtc'
  import { identity } from '../lib/identity'

  $: participantList = Array.from($participants.values())
  $: totalCount = participantList.length + 1 // +1 for local

  // Calculate optimal columns for the participant count (desktop)
  $: cols = totalCount === 1 ? 1
          : totalCount === 2 ? 2
          : totalCount <= 4 ? 2
          : totalCount <= 6 ? 3
          : totalCount <= 9 ? 3
          : 4

  // Calculate rows needed
  $: rows = Math.ceil(totalCount / cols)

  // Calculate tile width as percentage (accounting for gaps)
  $: tileWidth = `calc(${100 / cols}% - ${(cols - 1) * 16 / cols}px)`

  // Calculate max tile height to fit in container (accounting for gaps and padding)
  // Height = (100% - padding - gaps) / rows
  $: tileMaxHeight = `calc((100% - ${(rows - 1) * 16}px) / ${rows})`
</script>

<div class="video-grid flex flex-wrap justify-center content-center gap-4 w-full h-full overflow-hidden">
  <!-- Local video -->
  <div class="video-tile-wrapper" style="--desktop-width: {tileWidth}; --max-height: {tileMaxHeight};">
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
  </div>

  <!-- Remote participants -->
  {#each participantList as participant (participant.pubkey)}
    <div class="video-tile-wrapper" style="--desktop-width: {tileWidth}; --max-height: {tileMaxHeight};">
      <VideoTile
        stream={participant.stream}
        pubkey={participant.pubkey}
        muted={false}
        mirrored={false}
        audioEnabled={participant.audioEnabled}
        videoEnabled={participant.videoEnabled}
        isLocal={false}
      />
    </div>
  {/each}
</div>

<style>
  .video-grid {
    padding: 1rem;
    padding-top: calc(1rem + env(safe-area-inset-top, 0px));
    padding-bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
    padding-left: calc(1rem + env(safe-area-inset-left, 0px));
    padding-right: calc(1rem + env(safe-area-inset-right, 0px));
  }

  .video-tile-wrapper {
    width: 100%;
    max-width: 100%;
    max-height: var(--max-height);
    flex-shrink: 0;
  }

  /* Constrain tile width based on max-height to maintain aspect ratio */
  .video-tile-wrapper :global([data-testid="video-tile"]) {
    max-height: var(--max-height);
    width: auto;
    max-width: 100%;
    margin: 0 auto;
  }

  @media (min-width: 640px) {
    .video-tile-wrapper {
      width: var(--desktop-width);
    }
  }
</style>
