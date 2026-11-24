import type {
  APIResponse,
  Frame as PlaywrightFrame,
  Locator as PlaywrightLocator,
  Page as PlaywrightPage,
  Response as PlaywrightResponse,
} from 'playwright-core';
import type { extractUnicomWebBalance } from '../../../../../shared/unicom-web-balance.js';
import type { extractM1WebBalance } from '../../../../../shared/m1-web-balance.js';

export type Candidate = Pick<PlaywrightLocator, 'isVisible' | 'innerText'>;

export interface CandidateList<C extends Candidate> extends Pick<PlaywrightLocator, 'count'> {
  nth(index: number): C;
}

export interface Locator
  extends
    Candidate,
    CandidateList<Locator>,
    Pick<PlaywrightLocator, 'click' | 'fill' | 'check' | 'isChecked'> {}

export type Waiter = Pick<PlaywrightPage, 'waitForTimeout'>;

export interface Surface extends Waiter {
  locator(selector: string): Locator;
  getByText(text: string | RegExp, options?: { exact?: boolean }): Locator;
  getByRole(role: 'button' | 'link', options: { name: RegExp }): Locator;
}

export type Frame = Surface & Pick<PlaywrightFrame, 'name' | 'url'>;

export type ApiResponse = Pick<APIResponse, 'status' | 'text'>;

export interface PageResponse extends ApiResponse, Pick<PlaywrightResponse, 'url' | 'ok'> {
  request(): { method(): string };
}

export interface Page
  extends Surface, Pick<PlaywrightPage, 'url' | 'title' | 'isClosed' | 'bringToFront'> {
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>;
  frames(): Frame[];
  mainFrame(): Frame;
  screenshot(options: { path: string; fullPage: boolean }): Promise<unknown>;
  waitForResponse(
    predicate: (response: PageResponse) => Promise<boolean>,
    options: { timeout: number },
  ): Promise<PageResponse>;
}

export type UnicomRequestHeaders = Record<'accept' | 'content-type' | 'origin' | 'referer', string>;

export interface BrowserContext {
  pages(): Page[];
  newPage(): Promise<Page>;
  close(): Promise<void>;
  request: {
    post(url: string, options: { headers: UnicomRequestHeaders }): Promise<ApiResponse>;
  };
}

export interface Logger {
  log(message: string): void;
  error(message: string): void;
}

export interface LoginPanel {
  context: Surface;
  locator: Locator;
}

export type CarrierBalance =
  ReturnType<typeof extractM1WebBalance> | ReturnType<typeof extractUnicomWebBalance>;

export type CarrierTarget =
  | { provider: 'unicom'; queryOrigin: string; queryEndpoint: string }
  | { provider: 'm1'; balanceUrl: string };
