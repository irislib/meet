<script lang="ts">
  import VideoTile from './VideoTile.svelte'
  import { participants, localMedia } from '../lib/webrtc'
  import { identity } from '../lib/identity'

  $: participantList = Array.from($participants.values())
  $: totalCount = participantList.length + 1 // +1 for local

  // Calculate grid layout
  $: gridCols = totalCount <= 1 ? 1
              : totalCount <= 4 ? 2
              : totalCount <= 9 ? 3
              : 4
</script>

<div
  class="grid gap-4 p-4 w-full h-full auto-rows-fr"
  style="grid-template-columns: repeat({gridCols}, minmax(0, 1fr));"
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
