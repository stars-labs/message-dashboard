<script>
  import { onMount, onDestroy } from 'svelte';
  import { captureException, trackComponentError } from './sentry-utils';
  
  export let componentName = 'Unknown';
  export let fallback = null;
  
  let hasError = false;
  let errorMessage = '';
  let errorDetails = null;
  
  // Capture errors during component lifecycle
  function handleError(error) {
    hasError = true;
    errorMessage = error.message || 'An unexpected error occurred';
    errorDetails = error;
    
    // Track error in Sentry
    trackComponentError(componentName, 'runtime', error);
    
    console.error(`[ErrorBoundary] Error in ${componentName}:`, error);
  }
  
  // Reset error state
  export function reset() {
    hasError = false;
    errorMessage = '';
    errorDetails = null;
  }
  
  // Capture unhandled errors in child components
  onMount(() => {
    const handleWindowError = (event) => {
      if (event.error) {
        handleError(event.error);
        event.preventDefault();
      }
    };
    
    const handleUnhandledRejection = (event) => {
      handleError(new Error(event.reason || 'Unhandled promise rejection'));
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
  {#if fallback}
    <svelte:component this={fallback} 
      error={errorDetails} 
      message={errorMessage}
      onReset={reset} 
    />
  {:else}
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
  {/if}
{:else}
  <slot />
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