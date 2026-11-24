<script lang="ts">
  import type { Phone } from '../../shared/api/phones.js';
  import type { ApiMessage } from '../../shared/api/messages.js';
  import type { DaemonView } from '../lib/daemon-status.js';
  import MessageComposer from '../lib/MessageComposer.svelte';
  import PhoneDetails from '../lib/PhoneDetails.svelte';
  import PhoneList from '../lib/PhoneList.svelte';
  import SimpleMessageView from '../lib/SimpleMessageView.svelte';
  import type { BalanceChecks } from './balance-checks.svelte.js';
  import type { MessageFeed } from './message-feed.svelte.js';
  import ReceiverSheet from './ReceiverSheet.svelte';
  import StatsBar from './StatsBar.svelte';
  import type { Permission, ViewPhone } from './types.js';

  interface Props {
    phoneNumbers: readonly ViewPhone[];
    selectedPhone: ViewPhone | null;
    selectedPhoneIccid: string | null;
    selectedCountry: string;
    searchTerm: string;
    showPhoneList: boolean;
    dataLoading: boolean;
    can: Permission;
    feed: MessageFeed;
    balances: BalanceChecks;
    daemonStatus: DaemonView;
    onSelectPhone: (phone: Pick<Phone, 'iccid'> | null) => void;
    onSetIccidMapping: (phone: Pick<Phone, 'iccid'>) => void;
    onOpenIccidMappings: (filter: 'all' | 'error') => void;
    onOpenMessage: (message: ApiMessage) => void;
    onRetry: () => void;
  }

  let {
    phoneNumbers,
    selectedPhone,
    selectedPhoneIccid = $bindable(),
    selectedCountry = $bindable(),
    searchTerm = $bindable(),
    showPhoneList = $bindable(),
    dataLoading,
    can,
    feed,
    balances,
    daemonStatus,
    onSelectPhone,
    onSetIccidMapping,
    onOpenIccidMappings,
    onOpenMessage,
    onRetry,
  }: Props = $props();
</script>

<StatsBar {phoneNumbers} {can} {onOpenIccidMappings} />

<!-- Desktop grid: 3 columns (phone, messages, send) from 1600px, 2 below with send as a drawer. -->
<div class="px-0 sm:px-4 lg:px-5 lg:pt-4 lg:pb-4 lg:flex-1 lg:min-h-0 lg:flex lg:flex-col">
  <div
    class="lg:grid lg:gap-4 lg:flex-1 lg:min-h-0 lg:grid-cols-[288px_1fr] {can('messages.send')
      ? '2xl:grid-cols-[288px_1fr_352px]'
      : ''}"
  >
    {#if showPhoneList}
      <ReceiverSheet
        {phoneNumbers}
        bind:selectedPhoneIccid
        bind:selectedCountry
        bind:searchTerm
        isLoading={dataLoading}
        {onSelectPhone}
        {onSetIccidMapping}
        onClose={() => (showPhoneList = false)}
      />
    {/if}

    <div class="hidden lg:flex lg:flex-col h-full min-h-0">
      <PhoneList
        {phoneNumbers}
        bind:selectedPhoneIccid
        bind:selectedCountry
        bind:searchTerm
        {onSelectPhone}
        {onSetIccidMapping}
        isLoading={dataLoading}
      />
    </div>

    <div
      class="flex flex-col h-full min-h-0 {selectedPhone
        ? 'lg:grid lg:grid-rows-[minmax(300px,1fr)_auto] lg:gap-3'
        : ''}"
    >
      <div class="min-h-0 flex flex-col">
        <SimpleMessageView
          messages={feed.messages}
          {selectedPhone}
          isLoading={dataLoading}
          newMessageIds={feed.newMessageIds}
          onClearPhone={() => {
            onSelectPhone(null);
          }}
          showFiltered={feed.showFiltered}
          filterRules={feed.filterRules}
          onToggleFiltered={feed.toggleFiltered}
          balanceChecks={balances.checks}
          onOpenBalance={balances.open}
          {onOpenMessage}
          hasMore={feed.hasMore}
          onLoadMore={feed.loadOlder}
          loadingMore={feed.loadingOlder}
          loadError={feed.loadError}
          fromCache={feed.fromCache}
          {onRetry}
        />
      </div>
      {#if selectedPhone}
        <div class="hidden lg:block min-h-0">
          <PhoneDetails
            phone={selectedPhone}
            mobile={false}
            {daemonStatus}
            balanceCheck={balances.latestForSelected}
            onOpenBalance={balances.open}
            phones={phoneNumbers}
          />
        </div>
      {/if}
    </div>

    {#if can('messages.send')}
      <div class="hidden 2xl:flex 2xl:flex-col h-full min-h-0">
        <MessageComposer
          {selectedPhone}
          {phoneNumbers}
          messages={feed.messages}
          onmessagesent={feed.send}
        />
      </div>
    {/if}
  </div>
</div>
