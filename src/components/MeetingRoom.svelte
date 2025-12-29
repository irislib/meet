<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte'
  import VideoGrid from './VideoGrid.svelte'
  import Controls from './Controls.svelte'
  import Chat from './Chat.svelte'
  import { joinRoom, leaveRoom, toggleAudio, toggleVideo, restoreMediaPrefsForMeeting } from '../lib/webrtc'
  import { getMeetingLink, type Meeting } from '../lib/meeting'

  export let meeting: Meeting

  const dispatch = createEventDispatcher()

  let error = ''
  let joining = true
  let copied = false
  let chatOpen = false

  function handleKeydown(e: KeyboardEvent) {
    // Don't trigger shortcuts when typing in chat
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'd' || e.key === 'D') {
        e.preventDefault()
        toggleAudio()
      } else if (e.key === 'e' || e.key === 'E') {
        e.preventDefault()
        toggleVideo()
      }
    }
  }

  onMount(async () => {
    window.addEventListener('keydown', handleKeydown)

    try {
      // Join the meeting room (camera/mic start off, user enables when ready)
      await joinRoom(meeting.privkeyHex)

      // Restore camera/mic if rejoining the same meeting
      await restoreMediaPrefsForMeeting(meeting.pubkey)

      joining = false
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to join meeting'
      joining = false
    }
  })

  onDestroy(() => {
    window.removeEventListener('keydown', handleKeydown)
    leaveRoom()
  })

  async function handleLeave() {
    await leaveRoom()
    dispatch('leave')
  }

  async function handleCopyLink() {
    const link = getMeetingLink(meeting)
    try {
      await navigator.clipboard.writeText(link)
      copied = true
      setTimeout(() => copied = false, 2000)
    } catch {
      // Fallback
      const input = document.createElement('input')
      input.value = link
      document.body.appendChild(input)
      input.select()
      document.execCommand('copy')
      document.body.removeChild(input)
      copied = true
      setTimeout(() => copied = false, 2000)
    }
  }
</script>

<div class="fixed inset-0 bg-surface-dark flex flex-col">
  <!-- Main content -->
  <div class="flex-1 overflow-hidden flex">
    <div class="flex-1 pb-20 overflow-hidden">
      {#if joining}
        <div class="w-full h-full flex items-center justify-center">
          <div class="text-center">
            <div class="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
            <p class="text-gray-400">Joining meeting...</p>
          </div>
        </div>
      {:else if error}
        <div class="w-full h-full flex items-center justify-center">
          <div class="text-center max-w-md p-6">
            <div class="w-16 h-16 rounded-full bg-red-900/30 flex items-center justify-center mx-auto mb-4">
              <span class="i-carbon-warning text-3xl text-red-500"></span>
            </div>
            <h2 class="text-xl font-bold text-white mb-2">Failed to Join</h2>
            <p class="text-gray-400 mb-4">{error}</p>
            <button class="btn-secondary" on:click={handleLeave}>
              Go Back
            </button>
          </div>
        </div>
      {:else}
        <VideoGrid />
      {/if}
    </div>

    <!-- Chat -->
    <Chat bind:isOpen={chatOpen} />
  </div>

  <!-- Controls -->
  {#if !joining && !error}
    <Controls showCopyLink={true} {copied} on:leave={handleLeave} on:copyLink={handleCopyLink} on:toggleChat={() => chatOpen = !chatOpen} />
  {/if}
</div>
