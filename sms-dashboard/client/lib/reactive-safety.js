/**
 * Reactive Safety Framework
 * Prevents infinite reactive loops and manages async operations safely
 */

/**
 * Debounced reactive updates to prevent rapid fire changes
 * Use for expensive operations triggered by reactive statements
 */
export function createDebouncedReactive(fn, delay = 100) {
  let timeoutId = null;
  let isRunning = false;
  
  return function debouncedExecute(...args) {
    if (isRunning) {
      console.debug('[ReactiveSafety] Skipping call - already running');
      return;
    }
    
    clearTimeout(timeoutId);
    timeoutId = setTimeout(async () => {
      isRunning = true;
      try {
        await fn(...args);
      } catch (error) {
        console.error('[ReactiveSafety] Debounced function error:', error);
      } finally {
        isRunning = false;
      }
    }, delay);
  };
}

/**
 * Safe async operation manager
 * Prevents concurrent execution of the same operation
 */
export function createSafeAsyncOperation(operationName) {
  let isRunning = false;
  let runCount = 0;
  
  return function safeExecute(asyncFn) {
    const currentRun = ++runCount;
    
    if (isRunning) {
      console.debug(`[ReactiveSafety] ${operationName} already running (run #${currentRun}), skipping`);
      return Promise.resolve();
    }
    
    console.debug(`[ReactiveSafety] Starting ${operationName} (run #${currentRun})`);
    isRunning = true;
    
    return Promise.resolve(asyncFn())
      .then(result => {
        console.debug(`[ReactiveSafety] ${operationName} completed (run #${currentRun})`);
        return result;
      })
      .catch(error => {
        console.error(`[ReactiveSafety] ${operationName} failed (run #${currentRun}):`, error);
        throw error;
      })
      .finally(() => {
        isRunning = false;
      });
  };
}

/**
 * Dependency cycle detector for reactive statements
 * Use in development to catch potential infinite loops
 */
export function createReactiveCycleDetector(maxCycles = 10) {
  const cycleCount = new Map();
  
  return function detectCycle(reactiveId, currentDeps) {
    if (import.meta.env.MODE !== 'development') return;
    
    const depsKey = JSON.stringify(currentDeps);
    const key = `${reactiveId}:${depsKey}`;
    
    const count = cycleCount.get(key) || 0;
    cycleCount.set(key, count + 1);
    
    if (count > maxCycles) {
      console.error(`[ReactiveSafety] Potential infinite loop detected in ${reactiveId}`);
      console.error('Dependencies:', currentDeps);
      console.error('Consider using debouncing or breaking the reactive dependency');
      
      // In development, throw to make the issue obvious
      throw new Error(`Infinite reactive loop detected: ${reactiveId}`);
    }
    
    // Clean up old entries periodically
    if (cycleCount.size > 100) {
      const oldestEntries = Array.from(cycleCount.entries())
        .sort(([,a], [,b]) => a - b)
        .slice(0, 50);
      
      oldestEntries.forEach(([key]) => cycleCount.delete(key));
    }
  };
}

/**
 * Safe Map update utility
 * Returns new Map instead of mutating existing one
 */
export function safeMapUpdate(currentMap, updateFn) {
  const newMap = new Map(currentMap);
  updateFn(newMap);
  return newMap;
}

/**
 * Reactive state validator
 * Ensures state changes are intentional and valid
 */
export function createStateValidator(validationFn, stateName = 'unknown') {
  return function validateState(newState, oldState) {
    try {
      const isValid = validationFn(newState, oldState);
      if (!isValid) {
        console.warn(`[ReactiveSafety] Invalid state transition in ${stateName}`);
        console.warn('Old state:', oldState);
        console.warn('New state:', newState);
        return false;
      }
      return true;
    } catch (error) {
      console.error(`[ReactiveSafety] State validation error in ${stateName}:`, error);
      return false;
    }
  };
}

/**
 * Usage examples and patterns
 */
export const reactivePatterns = {
  // Pattern 1: Debounced reactive statement
  debouncedTagFetch: createDebouncedReactive(async (messageIds) => {
    // Safe tag fetching with debouncing
    console.log('Fetching tags for:', messageIds);
  }, 150),
  
  // Pattern 2: Safe async operation
  safeTagLoad: createSafeAsyncOperation('tag-load'),
  
  // Pattern 3: Cycle detection
  messageViewCycleDetector: createReactiveCycleDetector(5),
  
  // Pattern 4: State validation
  tagMapValidator: createStateValidator((newMap, oldMap) => {
    // Ensure Map is valid and not corrupted
    return newMap instanceof Map && 
           newMap.size >= 0 &&
           newMap.size < 50000; // Reasonable upper bound
  }, 'messageTags')
};

/**
 * Reactive Safety Checklist for Components
 * 
 * ✅ Use debouncing for expensive reactive operations
 * ✅ Implement concurrency protection for async operations  
 * ✅ Replace Map mutation with Map replacement
 * ✅ Add cycle detection in development
 * ✅ Validate state changes
 * ✅ Use requestAnimationFrame for DOM updates
 * ✅ Clear timers and cleanup on component destroy
 * ✅ Separate concerns: UI state vs Business logic
 */