<script>
  // Renders SMS content with keyword matches highlighted.
  //
  // This component displays fully attacker-controlled text: anyone who knows one of the
  // SIM phone numbers can send an SMS containing arbitrary content. It previously built
  // an HTML string and rendered it with `{@html}`, escaping the message text and tag but
  // NOT the keyword colour, which let a stored colour like `red" onmouseover="..."` break
  // out of the style attribute and run script in an operator's browser.
  // See docs/SECURITY-REVIEW.md finding 2.
  //
  // There is no `{@html}` here any more. Matches are emitted as real elements and every
  // interpolation — text, tag and colour — goes through Svelte's escaping. The slicing
  // logic lives in message-highlight.js so it can be unit tested.
  import { getSegments } from './message-highlight.js';

  let { content = '', keywords = [] } = $props();

  let segments = $derived(getSegments(content, keywords));
</script>

<!-- Deliberately one line with no whitespace between block tags: segments are adjacent
     runs of the original SMS text, so any newline or indentation Svelte kept as a text
     node would insert spaces into the rendered message. -->
<span class="break-words">{#if segments}{#each segments as segment}{#if segment.match}<mark class="kw-hl" style:--kw-color={segment.match.color} title={segment.match.tag}>{segment.text}</mark>{:else}{segment.text}{/if}{/each}{:else}{content}{/if}</span>

<style>
  :global(.kw-hl) {
    background: color-mix(in srgb, var(--kw-color, #3B82F6) 15%, transparent);
    border-bottom: 2px solid var(--kw-color, #3B82F6);
    color: inherit;
    padding: 0 1px;
    border-radius: 2px;
    font-weight: 600;
  }
</style>
