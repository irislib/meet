<script lang="ts">
  import SharedName from '@iris/svelte-ui/Name.svelte'
  import { createProfileStore, getProfileName, type Profile } from '../lib/profile'
  import { getAnimalName } from '../lib/animalNames'

  export let pubkey: string

  let profile: Profile | undefined

  $: profileStore = pubkey ? createProfileStore(pubkey) : null
  $: profile = profileStore ? ($profileStore ?? undefined) : undefined
  $: profileName = getProfileName(profile)
  $: animalName = getAnimalName(pubkey)
</script>

<SharedName
  {pubkey}
  {profile}
  name={profileName}
  fallbackName={animalName}
  class="truncate"
  fallbackClass="italic opacity-70"
/>
