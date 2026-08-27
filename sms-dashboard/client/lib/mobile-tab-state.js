const ADMIN_TABS = Object.freeze(['dashboard', 'iccid-mappings', 'balances', 'send', 'more']);
const VIEWER_TABS = Object.freeze(['dashboard', 'balances', 'send', 'more']);
const MORE_VIEWS = new Set(['keywords', 'filters', 'users']);

export function getMobileTabs(canManagePhones) {
  return canManagePhones ? ADMIN_TABS : VIEWER_TABS;
}

export function getMobileTabState({ currentView, showMoreMenu, canManagePhones }) {
  const tabs = getMobileTabs(canManagePhones);
  const selectedView = showMoreMenu || MORE_VIEWS.has(currentView)
    ? 'more'
    : currentView;
  const index = tabs.indexOf(selectedView);

  return {
    count: tabs.length,
    index: index === -1 ? 0 : index,
  };
}

export function getMobileTabIndexAtPoint({ clientX, left, width, count }) {
  const tabWidth = width / count;
  const index = Math.floor((clientX - left) / tabWidth);
  return Math.max(0, Math.min(count - 1, index));
}

export function getMobileTabDragX({ clientX, left, width, count }) {
  const tabWidth = width / count;
  const selectionWidth = tabWidth - 8;
  const centeredX = clientX - left - (selectionWidth / 2) - 4;
  return Math.max(0, Math.min(width - tabWidth, centeredX));
}
