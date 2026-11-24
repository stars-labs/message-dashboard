<script lang="ts">
  // The SMS text is attacker-controlled. Never use `{@html}` here: every interpolation
  // (text, tag, colour) must go through Svelte's escaping.
  import { getSegments, type HighlightKeyword } from './message-highlight.js';

  interface Props {
    content?: string | null;
    keywords?: readonly HighlightKeyword[];
  }

  let { content = '', keywords = [] }: Props = $props();

  let segments = $derived(getSegments(content, keywords));
</script>

<!-- No whitespace between block tags: segments are adjacent runs of the SMS text, so any
     newline or indentation kept as a text node would add spaces to the message. -->
<span class="break-words"
  >{#if segments}{#each segments as segment, index (index)}{#if segment.match}<mark
          class="kw-hl"
          style:--kw-color={segment.match.color}
          title={segment.match.tag}>{segment.text}</mark
        >{:else}{segment.text}{/if}{/each}{:else}{content}{/if}</span
>

<style>
  :global(.kw-hl) {
    background: color-mix(in srgb, var(--kw-color, #3b82f6) 15%, transparent);
    border-bottom: 2px solid var(--kw-color, #3b82f6);
    color: inherit;
    padding: 0 1px;
    border-radius: 2px;
    font-weight: 600;
  }
</style>
