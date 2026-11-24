import type { Page } from 'playwright-core';
import type { FakeAI } from '../e2e/fake-ai.ts';
import type { LocalStack } from '../local-stack.ts';
import type { Viewport } from '../page-report.ts';

export interface JourneyContext {
  stack: Omit<LocalStack, 'stop'>;
  ai: Omit<FakeAI, 'stop'>;
  /** A blank page signed in as the admin; navigate it yourself. Its console and network problems fail the run. */
  page: (viewport?: Viewport) => Promise<Page>;
  /** Saves `data` as `<out>/<name>.json`, which outlives the stack. */
  evidence: (name: string, data: unknown) => Promise<void>;
  out: string;
}

/** What a journey module default-exports; throwing fails the run. */
export type Journey = (context: JourneyContext) => Promise<void>;
