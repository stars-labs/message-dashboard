// Types for the generated frontend-assets.js.
//
// The module is produced by scripts/build-unified.ts and is gitignored, so it
// does not exist in a clean checkout. A `.d.ts` with the same basename as the
// generated module is what TypeScript pairs it with, which is why the
// declaration lives here rather than in a wildcard module.

export interface FrontendAsset {
  content: string;
  type: string;
  encoding?: 'base64';
}

export const FRONTEND_ASSETS: Record<string, FrontendAsset>;
