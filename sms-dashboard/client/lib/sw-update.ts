// The worker is registered with `registerType: 'prompt'`, not `skipWaiting()`: a silent
// reload would drop unsaved filter/dialog state, so the reload is the user's decision.

interface UpdateState {
  available: boolean;
  applying: boolean;
}

export interface RegistrationLike {
  waiting: unknown;
  update(): Promise<unknown>;
}

export function createUpdateState(): UpdateState {
  return { available: false, applying: false };
}

export function needRefresh(state: UpdateState): void {
  // The activating worker can fire this again after the user accepted.
  if (state.applying) return;
  state.available = true;
}

export function dismiss(state: UpdateState): void {
  state.available = false;
}

export function applyUpdate(
  state: UpdateState,
  updateSW?: ((reloadPage?: boolean) => Promise<void>) | null,
): void {
  if (!state.available || state.applying) return;
  state.available = false;
  state.applying = true;
  void updateSW?.(true);
}

// Deliberately silent: the app works without a service worker.
export function registerError(state: UpdateState): void {
  state.available = false;
  state.applying = false;
}

// Covers long-lived iOS web apps that resume without navigating.
export function createUpdateChecker(state: UpdateState) {
  let registration: RegistrationLike | null = null;

  return {
    setRegistration(nextRegistration?: RegistrationLike | null): void {
      registration = nextRegistration ?? null;
      if (registration?.waiting) needRefresh(state);
    },

    async check(): Promise<boolean> {
      if (!registration || state.applying) return false;

      // A dismissed worker is still waiting; skip the network request.
      if (registration.waiting) {
        needRefresh(state);
        return true;
      }

      try {
        await registration.update();
      } catch {
        // Opportunistic: must not fail the data refresh when iOS is offline.
        return false;
      }

      if (!registration.waiting) return false;
      needRefresh(state);
      return true;
    },
  };
}
