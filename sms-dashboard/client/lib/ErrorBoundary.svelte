<script>
  import { onMount } from 'svelte';
  import { isForeignError, toError } from './error-origin.js';

  let { componentName = 'Unknown', children } = $props();

  let hasError = $state(false);
  let errorMessage = $state('');
  let errorDetails = $state(null);

  function handleError(error) {
    hasError = true;
    errorMessage = error.message || 'An unexpected error occurred';
    errorDetails = error;
    console.error(`[ErrorBoundary] Error in ${componentName}:`, error);
  }

  function reset() {
    hasError = false;
    errorMessage = '';
    errorDetails = null;
  }

  onMount(() => {
    // These are GLOBAL listeners, so they see every error on the page — including ones
    // thrown by browser extensions. A MetaMask injection failure used to blank the whole
    // dashboard. Foreign errors are left alone: not shown, and not preventDefault()ed, so
    // they still reach the console for whoever actually owns them.
    const handleWindowError = (event) => {
      if (!event.error) return;

      if (isForeignError({
        message: event.message ?? event.error?.message,
        filename: event.filename,
        stack: event.error?.stack,
      })) {
        return;
      }

      handleError(event.error);
      event.preventDefault();
    };

    const handleUnhandledRejection = (event) => {
      const error = toError(event.reason);

      if (isForeignError({ message: error.message, stack: error.stack })) return;

      handleError(error);
      event.preventDefault();
    };

    window.addEventListener('error', handleWindowError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);

    return () => {
      window.removeEventListener('error', handleWindowError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };
  });
</script>

{#if hasError}
  <div class="error-boundary p-4 bg-red-50 border border-red-200 rounded-lg">
    <h3 class="text-red-800 font-semibold mb-2">Something went wrong</h3>
    <p class="text-red-600 mb-3">{errorMessage}</p>
    <button
      onclick={reset}
      class="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition-colors"
    >
      Try Again
    </button>
    {#if import.meta.env.MODE === 'development' && errorDetails}
      <details class="mt-4">
        <summary class="cursor-pointer text-red-700 hover:underline">
          Error Details (Development Only)
        </summary>
        <pre class="mt-2 p-2 bg-red-100 rounded text-xs overflow-auto">
{JSON.stringify({
  message: errorDetails.message,
  stack: errorDetails.stack,
  name: errorDetails.name
}, null, 2)}
        </pre>
      </details>
    {/if}
  </div>
{:else}
  {@render children?.()}
{/if}

<style>
  .error-boundary {
    animation: slideIn 0.3s ease-out;
  }

  @keyframes slideIn {
    from {
      opacity: 0;
      transform: translateY(-10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
