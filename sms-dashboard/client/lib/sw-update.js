/**
 * Service worker update-prompt logic, kept DOM-free so it can be unit tested.
 *
 * The service worker is registered with `registerType: 'prompt'` rather than
 * `skipWaiting()`. Auto-takeover would swap the JS bundle underneath a live page:
 * the dashboard polls continuously and holds unsaved filter/dialog state, so a
 * silent reload can drop what the operator was in the middle of. Prompting makes
 * the reload the user's decision.
 */

export function createUpdateState() {
  return { available: false, applying: false };
}

/** A new worker is waiting. */
export function needRefresh(state) {
  // Once the user has committed to updating, the page is on its way to reloading —
  // the activating worker can fire this again, and re-showing the bar would flash a
  // prompt for a choice already made.
  if (state.applying) return;
  state.available = true;
}

/** User declined for now. A later update is free to prompt again. */
export function dismiss(state) {
  state.available = false;
}

/**
 * User accepted. `updateSW(true)` tells the waiting worker to take over and
 * reloads the page.
 */
export function applyUpdate(state, updateSW) {
  if (!state.available || state.applying) return;
  state.available = false;
  state.applying = true;
  updateSW?.(true);
}

/**
 * Registration failed. Deliberately silent: there is nothing the user can do
 * about it, and the app works fine without a service worker.
 */
export function registerError(state) {
  state.available = false;
  state.applying = false;
}

/**
 * Own the single service-worker registration used for explicit update checks.
 * The browser/Workbox callbacks still announce newly installed workers; this
 * checker covers long-lived iOS web apps that resume without navigating.
 */
export function createUpdateChecker(state) {
  let registration = null;

  return {
    setRegistration(nextRegistration) {
      registration = nextRegistration || null;
      if (registration?.waiting) needRefresh(state);
    },

    async check() {
      if (!registration || state.applying) return false;

      // A dismissed worker is still waiting. Surface it again without making a
      // redundant network request.
      if (registration.waiting) {
        needRefresh(state);
        return true;
      }

      try {
        await registration.update();
      } catch {
        // Update checks are opportunistic; API/data refresh must still succeed when
        // iOS is briefly offline or WebKit rejects a background update request.
        return false;
      }

      if (!registration.waiting) return false;
      needRefresh(state);
      return true;
    },
  };
}
