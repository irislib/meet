<script lang="ts">
  import { onMount } from 'svelte'
  import LoginForm from './components/LoginForm.svelte'
  import CreateMeeting from './components/CreateMeeting.svelte'
  import JoinMeeting from './components/JoinMeeting.svelte'
  import MeetingRoom from './components/MeetingRoom.svelte'
  import Avatar from './components/Avatar.svelte'
  import Name from './components/Name.svelte'
  import { identity, isLoggedIn, autoLogin, logout } from './lib/identity'
  import { parseMeetingFromHash, currentMeeting, leaveMeeting, type Meeting } from './lib/meeting'

  type View = 'login' | 'home' | 'meeting'

  let view: View = 'login'
  let initializing = true
  let showUserMenu = false

  function toggleUserMenu() {
    showUserMenu = !showUserMenu
  }

  function closeUserMenu() {
    showUserMenu = false
  }

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

  function handleLogout() {
    logout()
    leaveMeeting()
    view = 'login'
  }
</script>

<main class="min-h-screen bg-[#121212] text-white">
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
        <img src={`${import.meta.env.BASE_URL}iris-logo.png`} alt="Iris" class="w-16 h-16 mb-4" draggable="false" />
        <h1 class="text-4xl font-semibold">
          iris <span class="text-[#916dfe]">meet</span>
        </h1>
      </div>
      <LoginForm on:login={handleLogin} />
    </div>
  {:else if view === 'home'}
    <div class="min-h-screen flex flex-col">
      <!-- Header -->
      <header class="h-16 px-4 flex items-center justify-between border-b border-surface-lighter">
        <div class="flex items-center gap-2 select-none">
          <img src={`${import.meta.env.BASE_URL}iris-logo.png`} alt="Iris" class="w-8 h-8" draggable="false" />
          <h1 class="text-xl font-semibold">
            iris <span class="text-[#916dfe]">meet</span>
          </h1>
        </div>
        <div class="relative">
          <button
            class="flex items-center gap-2 cursor-pointer bg-transparent border-none p-0"
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
                on:click={() => { handleLogout(); closeUserMenu(); }}
              >
                <span class="i-carbon-logout"></span>
                Logout
              </button>
            </div>
          {/if}
        </div>
      </header>

      {#if showUserMenu}
        <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
        <div
          class="fixed inset-0 z-40"
          on:click={closeUserMenu}
        ></div>
      {/if}

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
          href="https://github.com/irislib/meet"
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
