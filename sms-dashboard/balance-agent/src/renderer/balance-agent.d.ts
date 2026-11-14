import type { BalanceAgentApi } from '../ipc/contract.js';

declare global {
  interface Window {
    readonly balanceAgent: BalanceAgentApi;
  }
}
