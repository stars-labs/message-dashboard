import {
  app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, safeStorage, shell, Tray,
} from 'electron';
import { join } from 'node:path';
import log from 'electron-log/main.js';
import { createAgentService } from './agent-service.js';
import { createMenuBarModel } from './menu-model.js';
import { createSecureStore } from './secure-store.js';
import { createSettingsStore } from './settings-store.js';

// Write to ~/Library/Logs/Balance Agent/main.log (macOS).
// Errors and above are also echoed to the terminal.
log.initialize();
log.transports.file.level = 'debug';
log.transports.console.level = 'warn';
// Catch any uncaught exceptions / unhandled rejections before app is ready.
log.catchErrors({ showDialog: false });

const gotLock = app.requestSingleInstanceLock();

let window = null;
let tray = null;
let quitting = false;
let service = null;
let previousBrowserDetail = null;
let latestState = {
  auth: 'signed_out',
  smsAi: 'stopped',
  browser: 'configuration_required',
  browserDetail: 'browser_runtime_unavailable',
  settings: {},
  error: null,
};

function openAtLogin() {
  return app.getLoginItemSettings().openAtLogin;
}

function withApplicationState(state) {
  return { ...state, openAtLogin: openAtLogin() };
}

function revealWindow(target) {
  if (!target || target.isDestroyed() || quitting) return;
  if (target.isMinimized()) target.restore();
  target.show();
  app.focus({ steal: true });
  target.focus();
}

function showWindow() {
  if (quitting) return;
  if (!app.isReady()) {
    app.once('ready', showWindow);
    return;
  }
  if (!window || window.isDestroyed()) createWindow();
  if (window.webContents.isLoadingMainFrame()) {
    window.once('ready-to-show', () => revealWindow(window));
    return;
  }
  revealWindow(window);
}

function createWindow() {
  window = new BrowserWindow({
    width: 760,
    height: 620,
    minWidth: 680,
    minHeight: 520,
    show: false,
    title: 'Balance Agent',
    backgroundColor: '#f7f6f4',
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.loadFile(join(import.meta.dirname, 'renderer/index.html'));
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on('closed', () => { window = null; });
}

function trayImage() {
  return nativeImage.createFromPath(join(import.meta.dirname, 'assets/trayIcon.png'));
}

function statusImage(indicator) {
  if (!indicator) return undefined;
  const image = nativeImage.createFromPath(join(
    import.meta.dirname,
    `assets/status-${indicator}.png`,
  ));
  return image.isEmpty() ? undefined : image;
}

async function openDashboard() {
  const value = latestState.settings?.dashboardUrl;
  if (!value) return;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Unsupported Dashboard URL');
    await shell.openExternal(url.toString());
  } catch (error) {
    log.error(`Could not open Dashboard: ${error.message}`);
    showWindow();
  }
}

async function showVerificationWindow() {
  try {
    if (await service?.showVerification()) return;
  } catch (error) {
    log.error(`Could not focus verification window: ${error.message}`);
  }
  showWindow();
}

function setOpenAtLogin(enabled) {
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled), openAsHidden: true });
  const actual = openAtLogin();
  refreshTray();
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('agent:open-at-login', actual);
  }
  return actual;
}

function menuTemplate(model) {
  const actions = {
    'agent-header': showWindow,
    'status-dashboard': () => {
      if (latestState.settings?.dashboardUrl) void openDashboard();
      else showWindow();
    },
    'status-sms-ai': showWindow,
    'status-browser': () => {
      if (latestState.browserDetail === 'human_verification_required') {
        void showVerificationWindow();
      } else showWindow();
    },
    'status-error': showWindow,
    'show-verification': () => { void showVerificationWindow(); },
    'open-dashboard': () => { void openDashboard(); },
    'open-settings': showWindow,
    'open-at-login': (item) => { setOpenAtLogin(item.checked); },
    quit: () => app.quit(),
  };
  return model.items.map((item) => {
    const { id, indicator, ...menuItem } = item;
    const icon = statusImage(indicator);
    if (!id) return { ...menuItem, ...(icon ? { icon } : {}) };
    return { ...menuItem, ...(icon ? { icon } : {}), click: actions[id] };
  });
}

function refreshTray() {
  if (!tray) return;
  const model = createMenuBarModel(latestState, { openAtLogin: openAtLogin() });
  const image = trayImage();
  tray.setImage(image);
  tray.setTitle(image.isEmpty() ? model.fallbackTitle : '');
  tray.setToolTip(model.tooltip);
  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate(model)));
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  refreshTray();
}

function acceptState(state) {
  latestState = { ...latestState, ...state };
  refreshTray();
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('agent:state', withApplicationState(latestState));
  }
}

async function snapshot() {
  const state = await service.snapshot();
  latestState = { ...latestState, ...state };
  refreshTray();
  return withApplicationState(latestState);
}

app.on('second-instance', showWindow);
app.on('open-url', (event) => {
  event.preventDefault();
  showWindow();
});
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', async (event) => {
  if (!service) return;
  event.preventDefault();
  const active = service;
  service = null;
  await active.shutdown();
  app.quit();
});

async function startApplication() {
  await app.whenReady();
  app.dock?.hide();
  app.setAsDefaultProtocolClient('message-dashboard-runner');
  createTray();

  if (app.isPackaged) process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
  const { chromium } = await import('playwright-core');
  const packagedExecutable = chromium.executablePath().replace('app.asar', 'app.asar.unpacked');

  const userData = app.getPath('userData');
  service = createAgentService({
    settingsStore: createSettingsStore(join(userData, 'settings.json')),
    secureStore: createSecureStore({
      filePath: join(userData, 'credentials.json'),
      safeStorage,
    }),
    openExternal: (url) => shell.openExternal(url),
    browser: chromium,
    browserExecutablePath: app.isPackaged
      ? packagedExecutable
      : (process.env.UNICOM_BROWSER_EXECUTABLE || (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : process.env.CHROME_BIN || '/usr/bin/google-chrome')),
    appVersion: app.getVersion(),
    logger: log,
    onState: (state) => {
      acceptState(state);
      if (state.browserDetail === 'human_verification_required'
        && previousBrowserDetail !== state.browserDetail) {
        const notification = new Notification({
          title: '余额查询需要操作',
          body: '请在已打开的联通页面完成人工验证。',
        });
        notification.on('click', () => { void showVerificationWindow(); });
        notification.show();
      }
      previousBrowserDetail = state.browserDetail;
    },
  });

  ipcMain.handle('agent:get-state', snapshot);
  ipcMain.handle('agent:save-settings', async (_event, settings) => {
    const state = await service.saveSettings(settings);
    acceptState(state);
    return withApplicationState(latestState);
  });
  ipcMain.handle('agent:test-ai', (_event, settings) => service.testAI(settings));
  ipcMain.handle('agent:test-configuration', (_event, settings) => service.testConfiguration(settings));
  ipcMain.handle('agent:sign-in', () => service.signIn());
  ipcMain.handle('agent:sign-out', () => service.signOut());
  ipcMain.handle('agent:set-open-at-login', (_event, enabled) => setOpenAtLogin(enabled));

  try {
    await service.initialize();
    await snapshot();
  } catch (error) {
    log.error(`Balance Agent initialization failed: ${error.message}`);
    acceptState({ error: error.message, auth: 'signed_out' });
  }
}

if (!gotLock) app.quit();
else {
  startApplication().catch((error) => {
    log.error(`Balance Agent startup failed: ${error.message}`);
    app.quit();
  });
}
