/// <reference types="svelte" />
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The API origin, when the SPA is served from somewhere else. */
  readonly VITE_API_BASE_URL?: string;
}
