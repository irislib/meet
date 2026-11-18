<script lang="ts">
  import { onMount } from 'svelte'
  import LoginForm from './components/LoginForm.svelte'
  import CreateMeeting from './components/CreateMeeting.svelte'
  import JoinMeeting from './components/JoinMeeting.svelte'
  import MeetingRoom from './components/MeetingRoom.svelte'
  import Avatar from './components/Avatar.svelte'
  import Name from './components/Name.svelte'
  import ProfileSettings from '@iris/svelte-ui/ProfileSettings.svelte'
  import { copyToClipboard } from '@iris/svelte-ui/clipboard'
  import { nip19 } from 'nostr-tools'
  import { identity, isLoggedIn, autoLogin, getLocalProfileNsec, logout } from './lib/identity'
  import { parseMeetingFromHash, currentMeeting, leaveMeeting, type Meeting } from './lib/meeting'

  type View = 'login' | 'home' | 'meeting'

  let view: View = 'login'
  let initializing = true
  let updateAvailable = false
  let logoutDialog: HTMLDialogElement
  let settingsDialog: HTMLDialogElement
  let showSettings = false
  let showUserMenu = false
  $: profiles = $identity ? [{
    id: $identity.pubkey,
    publicKey: nip19.npubEncode($identity.pubkey),
    name: $identity.displayName ?? undefined,
  }] : []
  const meetIconUrl = `${import.meta.env.BASE_URL}iris-meet-icon.svg`

  // Refresh idle pages when a release activates. In a room, let the attendee
  // choose when to reload so an update cannot unexpectedly end their call.
  $: if (updateAvailable && !initializing && view !== 'meeting') window.location.reload()

  function toggleUserMenu() {
    showUserMenu = !showUserMenu
  }

  function closeUserMenu() {
    showUserMenu = false
  }

  function openSettings() {
    showSettings = true
    settingsDialog.showModal()
    closeUserMenu()
  }

  function confirmProfileSignOut(pubkey: string) {
    if ($identity?.pubkey === pubkey) logoutDialog.showModal()
  }

  async function copyProfileSecretKey(pubkey: string) {
    if (await copyToClipboard(getLocalProfileNsec(pubkey)) !== 'copied') {
      throw new Error('Could not copy the private key.')
    }
  }

  onMount(() => {
    if (!('serviceWorker' in navigator)) return
    let controller = navigator.serviceWorker.controller
    const onControllerChange = () => {
      const next = navigator.serviceWorker.controller
      if (controller && next && next !== controller) updateAvailable = true
      controller = next
    }
    const checkForUpdate = () => {
      if (document.visibilityState === 'visible') {
        void navigator.serviceWorker.getRegistration().then(registration => registration?.update()).catch(() => {})
      }
    }
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)
    document.addEventListener('visibilitychange', checkForUpdate)
    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
      document.removeEventListener('visibilitychange', checkForUpdate)
    }
  })

  onMount(async () => {
    // Check for meeting in URL hash
    const hashMeeting = parseMeetingFromHash()

    // Try to auto-login
    const loggedIn = await autoLogin()

    if (loggedIn) {
      if (hashMeeting) {
        view = 'meeting'
      } else {
        view = 'home'
      }
    } else {
      view = 'login'
    }

    initializing = false
  })

  function handleLogin() {
    // Check if there's a meeting waiting to join
    if ($currentMeeting) {
      view = 'meeting'
    } else {
      view = 'home'
    }
  }

  function handleJoinMeeting(event: CustomEvent<{ meeting: Meeting }>) {
    currentMeeting.set(event.detail.meeting)
    // Update URL hash
    history.replaceState(null, '', `#${event.detail.meeting.privkeyHex}`)
    view = 'meeting'
  }

  function handleLeaveMeeting() {
    leaveMeeting()
    view = 'home'
  }

  function handleHomeClick() {
    leaveMeeting()
    view = 'home'
  }

  function handleLogout() {
    logoutDialog.close()
    settingsDialog.close()
    closeUserMenu()
    logout()
    leaveMeeting()
    view = 'login'
  }
</script>

<main class="min-h-screen bg-[#121212] text-white">
  {#if updateAvailable && view === 'meeting'}
    <div role="status" class="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex w-max max-w-[calc(100vw-2rem)] flex-wrap items-center justify-center gap-3 rounded-lg bg-surface-light px-4 py-3 text-sm shadow-lg">
      <span>A new version of Meet is ready.</span>
      <button class="btn-secondary whitespace-nowrap" on:click={() => window.location.reload()}>Reload to update</button>
    </div>
  {/if}
  {#if initializing}
    <div class="min-h-screen flex items-center justify-center">
      <div class="text-center">
        <div class="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
        <p class="text-gray-400">Loading...</p>
      </div>
    </div>
  {:else if view === 'login'}
    <div class="min-h-screen flex flex-col items-center justify-center p-4">
      <div class="mb-8 text-center flex flex-col items-center select-none">
        <img src={meetIconUrl} alt="Iris Meet" class="w-16 h-16 mb-4 shrink-0" draggable="false" />
        <h1 class="text-4xl font-semibold leading-none">Meet</h1>
      </div>
      <LoginForm on:login={handleLogin} />
    </div>
  {:else if view === 'home'}
    <div class="min-h-screen flex flex-col">
      <!-- Header -->
      <header class="h-16 px-4 flex items-center justify-between border-b border-surface-lighter">
        <button
          class="inline-flex items-center gap-2 select-none bg-transparent border-none p-0 cursor-pointer hover:opacity-80 transition-opacity"
          type="button"
          on:click={handleHomeClick}
          aria-label="Go to home"
        >
          <img src={meetIconUrl} alt="Iris Meet" class="w-8 h-8 shrink-0" draggable="false" />
          <h1 class="text-xl font-semibold leading-none">Meet</h1>
        </button>
        <div class="flex items-center gap-2">
          <button type="button" class="btn-ghost" on:click={openSettings} aria-label="Settings">
            <span class="i-carbon-settings" aria-hidden="true"></span>
            <span class="hidden sm:inline">Settings</span>
          </button>
          <div class="relative">
            <button
              class="flex items-center gap-2 cursor-pointer bg-transparent border-none p-0"
              aria-label="Profile menu"
              aria-expanded={showUserMenu}
              on:click={toggleUserMenu}
            >
              <Avatar pubkey={$identity?.pubkey || ''} size={32} />
              <span class="text-sm text-gray-300 hidden sm:block"><Name pubkey={$identity?.pubkey || ''} /></span>
              <span class="i-carbon-chevron-down text-gray-400 text-xs"></span>
            </button>

            {#if showUserMenu}
              <div
                class="absolute right-0 top-full mt-1 w-48 bg-surface border border-surface-lighter rounded-lg shadow-xl z-50"
              >
                <button
                  class="btn-ghost w-full text-left text-sm flex items-center gap-2"
                  on:click={() => logoutDialog.showModal()}
                >
                  <span class="i-carbon-logout"></span>
                  Logout
                </button>
              </div>
            {/if}
          </div>
        </div>
      </header>

      {#if showUserMenu}
        <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
        <div
          class="fixed inset-0 z-40"
          on:click={closeUserMenu}
        ></div>
      {/if}

      <dialog bind:this={settingsDialog} on:close={() => showSettings = false} aria-labelledby="settings-title" class="m-auto w-11/12 max-w-lg rounded-xl bg-surface p-5 text-white backdrop:bg-black/60" style="--iris-settings-surface: #2d2d2d">
        <div class="mb-3 flex items-center justify-between gap-3">
          <h2 id="settings-title" class="text-lg font-semibold">Settings</h2>
          <form method="dialog">
            <button class="btn-secondary">Close</button>
          </form>
        </div>
        {#if showSettings}
          <ProfileSettings
            {profiles}
            activeProfileId={$identity?.pubkey ?? null}
            onSignOut={confirmProfileSignOut}
            onCopySecretKey={$identity?.canCopySecretKey ? copyProfileSecretKey : undefined}
          >
            {#snippet profileName(profile)}<Name pubkey={profile.id} />{/snippet}
            {#snippet profileAvatar(profile)}<Avatar pubkey={profile.id} size={36} />{/snippet}
          </ProfileSettings>
        {/if}
      </dialog>

      <dialog bind:this={logoutDialog} aria-labelledby="logout-title" class="m-auto max-w-sm rounded-xl bg-surface p-5 text-white backdrop:bg-black/60">
        <h2 id="logout-title" class="text-lg font-semibold">Log out?</h2>
        <p class="mt-2 text-sm text-gray-300">This will sign you out of Meet on this device.</p>
        {#if $identity?.canCopySecretKey}
          <p class="mt-2 text-sm text-gray-300">Save your private key from Settings if you want to keep using this profile. Signing out removes the key from this browser.</p>
        {/if}
        <div class="mt-5 flex justify-end gap-2">
          <button class="btn-secondary" on:click={() => logoutDialog.close()}>Cancel</button>
          <button class="btn-danger" on:click={handleLogout}>Log out</button>
        </div>
      </dialog>

      <!-- Main content -->
      <div class="flex-1 flex items-center justify-center p-4">
        <div class="w-full max-w-3xl space-y-6">
          <div class="grid md:grid-cols-2 gap-6">
            <CreateMeeting on:join={handleJoinMeeting} />
            <JoinMeeting on:join={handleJoinMeeting} />
          </div>
        </div>
      </div>

      <!-- Footer -->
      <footer class="py-4 text-center">
        <a
          href="https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/iris-meet"
          target="_blank"
          rel="noopener noreferrer"
          class="text-sm text-gray-500 hover:text-gray-400"
        >
          Source
        </a>
      </footer>
    </div>
  {:else if view === 'meeting' && $currentMeeting}
    <MeetingRoom meeting={$currentMeeting} on:leave={handleLeaveMeeting} />
  {/if}
</main>
