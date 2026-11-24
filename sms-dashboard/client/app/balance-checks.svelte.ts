import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import type { BalanceCheck, BalanceCheckDetail } from '../../shared/api/balance-checks.js';
import type { View } from '../../shared/views.js';
import { api, contractApi } from '../lib/api.js';
import { isActiveBalanceCheck } from '../lib/balance-polling.js';

interface QueriesChange {
  queuedChecks?: BalanceCheck[];
  activeIds?: string[];
}

interface BalanceContext {
  isSignedIn: () => boolean;
  view: () => View;
  selectedIccid: () => string | null;
}

export class BalanceChecks {
  private readonly context: BalanceContext;
  checks = $state<BalanceCheck[]>([]);
  detailCheck = $state<BalanceCheck | null>(null);
  detail = $state<BalanceCheckDetail | null>(null);

  constructor(context: BalanceContext) {
    this.context = context;
  }

  get latestForSelected() {
    const selectedIccid = this.context.selectedIccid();
    return selectedIccid
      ? (this.checks.find((check) => check.sim_iccid === selectedIccid) ?? null)
      : null;
  }

  private isDetailOpen(id: string) {
    return this.detailCheck?.id === id;
  }

  closeDetail = () => {
    this.detailCheck = null;
  };

  open = async (check: BalanceCheck) => {
    if (check.id === '') return;
    this.detailCheck = check;
    this.detail = null;
    try {
      const result = await contractApi.balanceChecks.detail({ params: { id: check.id } });
      if (this.isDetailOpen(check.id)) {
        this.detail = result.data;
      }
    } catch (error) {
      console.warn('Failed to load balance query detail:', error);
    }
  };

  refresh = async (options: QueriesChange = {}) => {
    if (!this.context.isSignedIn()) return;

    const queuedChecks = options.queuedChecks ?? [];
    if (queuedChecks.length > 0) {
      const queuedIds = new SvelteSet(queuedChecks.map(({ id }) => id));
      this.checks = [...queuedChecks, ...this.checks.filter(({ id }) => !queuedIds.has(id))];
      return;
    }

    const activeIds = options.activeIds ?? [];
    if (activeIds.length > 0) {
      const result = await contractApi.balanceChecks.status({
        query: { ids: activeIds.join(',') },
      });
      const updates = new SvelteMap(
        result.data.map((status): [string, typeof status] => [status.id, status]),
      );
      const reachedTerminal = activeIds.some((id) => {
        const update = updates.get(id);
        if (update === undefined) return true;
        const check = this.checks.find((candidate) => candidate.id === id);
        if (!check) return false;
        return isActiveBalanceCheck(check) && !isActiveBalanceCheck(update);
      });
      this.checks = this.checks.map((check) => {
        const update = updates.get(check.id);
        return update ? { ...check, ...update } : check;
      });
      if (!reachedTerminal) return;
    }

    const view = this.context.view();
    const selectedIccid = this.context.selectedIccid();

    if (view === 'balances') {
      this.checks = await api.getBalanceChecks({ limit: 100 });
      return;
    }

    if (view === 'dashboard' && selectedIccid) {
      const latest = await api.getBalanceChecks({
        phone_iccid: selectedIccid,
        limit: 1,
      });
      this.checks = [
        ...this.checks.filter((check) => check.sim_iccid !== this.context.selectedIccid()),
        ...latest,
      ];
    }
  };
}
