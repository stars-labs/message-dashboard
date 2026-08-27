const ADMIN_TABS = ['dashboard', 'iccid-mappings', 'balances', 'send', 'more'];
const VIEWER_TABS = ['dashboard', 'balances', 'send', 'more'];
const MORE_VIEWS = new Set(['keywords', 'filters', 'users']);

export function getMobileTabState({ currentView, showMoreMenu, canManagePhones }) {
  const tabs = canManagePhones ? ADMIN_TABS : VIEWER_TABS;
  const selectedView = showMoreMenu || MORE_VIEWS.has(currentView)
    ? 'more'
    : currentView;
  const index = tabs.indexOf(selectedView);

  return {
    count: tabs.length,
    index: index === -1 ? 0 : index,
  };
}
