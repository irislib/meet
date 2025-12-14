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

  // Calculate tile width as percentage (accounting for gaps)
  $: tileWidth = `calc(${100 / cols}% - ${(cols - 1) * 16 / cols}px)`
</script>

<div class="flex flex-wrap justify-center content-center gap-4 p-4 w-full h-full">
  <!-- Local video -->
  <div style="width: {tileWidth}; max-width: 100%;">
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
    <div style="width: {tileWidth}; max-width: 100%;">
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
