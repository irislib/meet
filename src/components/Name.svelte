<script lang="ts">
  import SharedName from '@iris/svelte-ui/Name.svelte'
  import { coolName } from '@iris/svelte-ui/profile'
  import { createProfileStore, getProfileName, type Profile } from '../lib/profile'

  export let pubkey: string

  let profile: Profile | undefined

  $: profileStore = pubkey ? createProfileStore(pubkey) : null
  $: profile = profileStore ? ($profileStore ?? undefined) : undefined
  $: profileName = getProfileName(profile)
  $: fallbackName = coolName(pubkey)
</script>

<SharedName
  {pubkey}
  {profile}
  name={profileName}
  {fallbackName}
  class="truncate"
  fallbackClass="italic opacity-70"
/>
