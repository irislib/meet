<script lang="ts">
  import SharedAvatar from '@iris/svelte-ui/Avatar.svelte'
  import { createProfileStore, getProfileName, type Profile } from '../lib/profile'
  import { getAnimalName } from '../lib/animalNames'

  export let pubkey: string
  export let size: number = 32

  let profile: Profile | undefined

  $: profileStore = pubkey ? createProfileStore(pubkey) : null
  $: profile = profileStore ? ($profileStore ?? undefined) : undefined
  $: name = getProfileName(profile) || getAnimalName(pubkey)
</script>

<SharedAvatar
  {pubkey}
  {profile}
  fallbackName={name}
  {size}
  saturation={90}
  lightness={50}
  alt={name}
  title={name}
  ariaHidden={false}
  class="rounded-full"
/>
