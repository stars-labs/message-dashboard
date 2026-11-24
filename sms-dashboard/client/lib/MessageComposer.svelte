<script lang="ts">
  import { onMount } from 'svelte';
  import type { ApiMessage } from '../../shared/api/messages.js';
  import type { Phone } from '../../shared/api/phones.js';
  import DesktopComposer from './composer/DesktopComposer.svelte';
  import MobileComposer from './composer/MobileComposer.svelte';
  import {
    ComposerState,
    type SenderPhone,
    type SentMessage,
  } from './composer/composer-state.svelte.js';

  interface Props {
    selectedPhone?: Pick<Phone, 'iccid'> | null;
    phoneNumbers?: readonly SenderPhone[];
    messages?: readonly Pick<ApiMessage, 'type' | 'recipient'>[];
    mobilePage?: boolean;
    onmessagesent?: ((message: SentMessage) => Promise<unknown>) | null;
  }

  let {
    selectedPhone = null,
    phoneNumbers = [],
    messages = [],
    mobilePage = false,
    onmessagesent = null,
  }: Props = $props();

  const composer = new ComposerState(() => ({
    selectedPhone,
    phoneNumbers,
    messages,
    onmessagesent,
  }));

  $effect(() => {
    composer.syncSelectedPhone();
  });

  // Persist only after restore completes, or the initial empty state overwrites the draft.
  onMount(() => {
    composer.loadRecipientHistory();

    if (!mobilePage) return;

    composer.restoreDraft();
    composer.draftReady = true;
  });

  $effect(() => {
    if (!mobilePage || !composer.draftReady) return;
    composer.persistDraft();
  });
</script>

<svelte:window onclick={composer.handleClickOutside} />

<DesktopComposer {composer} />

{#if mobilePage}
  <MobileComposer {composer} />
{/if}
