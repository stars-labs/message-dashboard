<script>
  import { captureException, logMessage, trackApiError } from './sentry-utils';
  
  let showDebug = import.meta.env.MODE === 'development';
  let testResults = [];
  
  function addResult(type, message) {
    testResults = [...testResults, {
      type,
      message,
      timestamp: new Date().toISOString()
    }];
  }
  
  function testBasicError() {
    try {
      addResult('info', 'Testing basic error capture...');
      throw new Error('Test error: Basic JavaScript error');
    } catch (error) {
      captureException(error, { test: 'basic_error' });
      addResult('success', 'Basic error sent to Sentry');
    }
  }
  
  function testTypeError() {
    try {
      addResult('info', 'Testing TypeError...');
      const obj = null;
      obj.nonExistent.property; // This will throw TypeError
    } catch (error) {
      captureException(error, { test: 'type_error' });
      addResult('success', 'TypeError sent to Sentry');
    }
  }
  
  function testApiError() {
    addResult('info', 'Testing API error tracking...');
    trackApiError('/api/test-endpoint', 500, {
      error: 'Internal Server Error',
      message: 'Test API error'
    }, { testData: 'sample' });
    addResult('success', 'API error sent to Sentry');
  }
  
  function testMessage() {
    addResult('info', 'Testing message logging...');
    logMessage('Test message: This is a test log message', 'info', {
      component: 'SentryTest',
      timestamp: Date.now()
    });
    addResult('success', 'Log message sent to Sentry');
  }
  
  function testUnhandledPromise() {
    addResult('info', 'Testing unhandled promise rejection...');
    // This will trigger an unhandled rejection
    Promise.reject(new Error('Test error: Unhandled promise rejection'));
    addResult('warning', 'Unhandled promise rejection triggered (check console)');
  }
  
  async function testNetworkError() {
    addResult('info', 'Testing network error...');
    try {
      await fetch('https://non-existent-domain-12345.com/api/test');
    } catch (error) {
      captureException(error, { test: 'network_error' });
      addResult('success', 'Network error sent to Sentry');
    }
  }
  
  function clearResults() {
    testResults = [];
  }
</script>

{#if showDebug}
<div class="fixed bottom-4 right-4 bg-white shadow-lg rounded-lg p-4 max-w-md z-50 border border-gray-200">
  <div class="flex items-center justify-between mb-3">
    <h3 class="text-lg font-semibold text-gray-800">Sentry Error Testing</h3>
    <button 
      onclick={() => showDebug = false}
      class="text-gray-500 hover:text-gray-700"
    >
      ✕
    </button>
  </div>
  
  <div class="grid grid-cols-2 gap-2 mb-3">
    <button 
      onclick={testBasicError}
      class="px-3 py-2 bg-red-500 text-white text-sm rounded hover:bg-red-600 transition-colors"
    >
      Basic Error
    </button>
    <button 
      onclick={testTypeError}
      class="px-3 py-2 bg-orange-500 text-white text-sm rounded hover:bg-orange-600 transition-colors"
    >
      TypeError
    </button>
    <button 
      onclick={testApiError}
      class="px-3 py-2 bg-yellow-500 text-white text-sm rounded hover:bg-yellow-600 transition-colors"
    >
      API Error
    </button>
    <button 
      onclick={testMessage}
      class="px-3 py-2 bg-blue-500 text-white text-sm rounded hover:bg-blue-600 transition-colors"
    >
      Log Message
    </button>
    <button 
      onclick={testUnhandledPromise}
      class="px-3 py-2 bg-purple-500 text-white text-sm rounded hover:bg-purple-600 transition-colors"
    >
      Promise Reject
    </button>
    <button 
      onclick={testNetworkError}
      class="px-3 py-2 bg-indigo-500 text-white text-sm rounded hover:bg-indigo-600 transition-colors"
    >
      Network Error
    </button>
  </div>
  
  {#if testResults.length > 0}
    <div class="border-t pt-3">
      <div class="flex justify-between items-center mb-2">
        <h4 class="text-sm font-semibold text-gray-700">Test Results:</h4>
        <button 
          onclick={clearResults}
          class="text-xs text-gray-500 hover:text-gray-700"
        >
          Clear
        </button>
      </div>
      <div class="max-h-32 overflow-y-auto">
        {#each testResults as result}
          <div class="flex items-start gap-2 text-xs mb-1">
            <span class={`
              ${result.type === 'success' ? 'text-green-600' : ''}
              ${result.type === 'error' ? 'text-red-600' : ''}
              ${result.type === 'warning' ? 'text-yellow-600' : ''}
              ${result.type === 'info' ? 'text-blue-600' : ''}
            `}>
              {result.type === 'success' ? '✓' : ''}
              {result.type === 'error' ? '✗' : ''}
              {result.type === 'warning' ? '⚠' : ''}
              {result.type === 'info' ? 'ℹ' : ''}
            </span>
            <span class="text-gray-600">{result.message}</span>
          </div>
        {/each}
      </div>
    </div>
  {/if}
  
  <div class="mt-3 text-xs text-gray-500">
    <p>Environment: {import.meta.env.MODE}</p>
    <p>Check Sentry dashboard for captured errors</p>
  </div>
</div>
{:else}
<button 
  onclick={() => showDebug = true}
  class="fixed bottom-4 right-4 bg-gray-800 text-white px-3 py-2 rounded-lg shadow-lg text-xs hover:bg-gray-700 transition-colors z-50"
>
  Sentry Debug
</button>
{/if}