import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  safeStorage,
  shell,
  Tray,
  type MenuItem as ElectronMenuItem,
  type MenuItemConstructorOptions,
} from 'electron';
import { join } from 'node:path';
import log from 'electron-log/main.js';
import * as v from 'valibot';
import { errorText } from '../../shared/error-text.js';
import { textOr } from '../../shared/text.js';
import {
  createAgentService,
  INITIAL_SERVICE_STATE,
  type AgentService,
  type AgentSnapshot,
} from './agent-service.js';
import { BLANK_SETTINGS, CHANNEL, SettingsForm, type AgentState } from './ipc/contract.js';
import {
  createMenuBarModel,
  type MenuBarModel,
  type MenuIndicator,
  type MenuItemId,
} from './menu-model.js';
import { createSecureStore } from './secure-store.js';
import { createSettingsStore } from './settings-store.js';

// Write to ~/Library/Logs/Balance Agent/main.log (macOS).
// Errors and above are also echoed to the terminal.
log.initialize();
log.transports.file.level = 'debug';
log.transports.console.level = 'warn';
// Catch any uncaught exceptions / unhandled rejections before app is ready.
log.errorHandler.startCatching({ showDialog: false });

const gotLock = app.requestSingleInstanceLock();

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let service: AgentService | null = null;
let previousBrowserDetail: string | null = null;
let latestState: AgentSnapshot = {
  ...INITIAL_SERVICE_STATE,
  settings: BLANK_SETTINGS,
  hasAiToken: false,
};

function openAtLogin(): boolean {
  return app.getLoginItemSettings().openAtLogin;
}

function withApplicationState(state: AgentSnapshot): AgentState {
  return { ...state, openAtLogin: openAtLogin() };
}

function revealWindow(target: BrowserWindow) {
  if (target.isDestroyed() || quitting) return;
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
  const target = window && !window.isDestroyed() ? window : createWindow();
  if (target.webContents.isLoadingMainFrame()) {
    target.once('ready-to-show', () => {
      revealWindow(target);
    });
    return;
  }
  revealWindow(target);
}

function createWindow(): BrowserWindow {
  const created = new BrowserWindow({
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
  window = created;
  void created.loadFile(join(import.meta.dirname, 'renderer/index.html'));
  created.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      created.hide();
    }
  });
  created.on('closed', () => {
    window = null;
  });
  return created;
}

function trayImage() {
  return nativeImage.createFromPath(join(import.meta.dirname, 'assets/trayIcon.png'));
}

function statusImage(indicator: MenuIndicator | undefined) {
  if (!indicator) return undefined;
  const image = nativeImage.createFromPath(
    join(import.meta.dirname, `assets/status-${indicator}.png`),
  );
  return image.isEmpty() ? undefined : image;
}

async function openDashboard() {
  const value = latestState.settings.dashboardUrl;
  if (!value) return;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Unsupported Dashboard URL');
    await shell.openExternal(url.toString());
  } catch (error) {
    log.error(`Could not open Dashboard: ${errorText(error)}`);
    showWindow();
  }
}

async function showVerificationWindow() {
  try {
    if (await service?.showVerification()) return;
  } catch (error) {
    log.error(`Could not focus verification window: ${errorText(error)}`);
  }
  showWindow();
}

function setOpenAtLogin(enabled: boolean): boolean {
  app.setLoginItemSettings({ openAtLogin: enabled });
  const actual = openAtLogin();
  refreshTray();
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send(CHANNEL.openAtLogin, actual);
  }
  return actual;
}

function menuTemplate(model: MenuBarModel): MenuItemConstructorOptions[] {
  const actions: Readonly<Record<MenuItemId, (item: ElectronMenuItem) => void>> = {
    'agent-header': showWindow,
    'status-dashboard': () => {
      if (latestState.settings.dashboardUrl) void openDashboard();
      else showWindow();
    },
    'status-sms-ai': showWindow,
    'status-browser': () => {
      if (latestState.browserDetail === 'human_verification_required') {
        void showVerificationWindow();
      } else showWindow();
    },
    'status-error': showWindow,
    'show-verification': () => {
      void showVerificationWindow();
    },
    'open-dashboard': () => {
      void openDashboard();
    },
    'open-settings': showWindow,
    'open-at-login': (item) => {
      setOpenAtLogin(item.checked);
    },
    quit: () => {
      app.quit();
    },
  };
  return model.items.map((item): MenuItemConstructorOptions => {
    if (!('id' in item)) return { type: 'separator' };
    const { id, indicator, ...menuItem } = item;
    const icon = statusImage(indicator);
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

function acceptState(state: Partial<AgentSnapshot>) {
  latestState = { ...latestState, ...state };
  refreshTray();
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send(CHANNEL.state, withApplicationState(latestState));
  }
}

async function snapshot(active: AgentService): Promise<AgentState> {
  const state = await active.snapshot();
  latestState = { ...latestState, ...state };
  refreshTray();
  return withApplicationState(latestState);
}

function developmentBrowserExecutable(): string {
  return textOr(
    process.env['UNICOM_BROWSER_EXECUTABLE'],
    process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : textOr(process.env['CHROME_BIN'], '/usr/bin/google-chrome'),
  );
}

app.on('second-instance', showWindow);
app.on('open-url', (event) => {
  event.preventDefault();
  showWindow();
});
app.on('before-quit', () => {
  quitting = true;
});
app.on('will-quit', (event) => {
  if (!service) return;
  event.preventDefault();
  const active = service;
  service = null;
  void active.shutdown().then(() => {
    app.quit();
  });
});

async function startApplication() {
  await app.whenReady();
  app.dock?.hide();
  app.setAsDefaultProtocolClient('message-dashboard-runner');
  createTray();

  if (app.isPackaged) process.env['PLAYWRIGHT_BROWSERS_PATH'] = '0';
  const { chromium } = await import('playwright-core');
  const packagedExecutable = chromium.executablePath().replace('app.asar', 'app.asar.unpacked');

  const userData = app.getPath('userData');
  const agent = createAgentService({
    settingsStore: createSettingsStore(join(userData, 'settings.json')),
    secureStore: createSecureStore({
      filePath: join(userData, 'credentials.json'),
      safeStorage,
    }),
    openExternal: (url) => shell.openExternal(url),
    browser: chromium,
    browserExecutablePath: app.isPackaged ? packagedExecutable : developmentBrowserExecutable(),
    appVersion: app.getVersion(),
    logger: log,
    onState: (state) => {
      acceptState(state);
      if (
        state.browserDetail === 'human_verification_required' &&
        previousBrowserDetail !== state.browserDetail
      ) {
        const notification = new Notification({
          title: '余额查询需要操作',
          body: '请在已打开的联通页面完成人工验证。',
        });
        notification.on('click', () => {
          void showVerificationWindow();
        });
        notification.show();
      }
      previousBrowserDetail = state.browserDetail;
    },
  });
  service = agent;

  ipcMain.handle(CHANNEL.getState, () => snapshot(agent));
  ipcMain.handle(CHANNEL.saveSettings, async (_event, input: unknown) => {
    const state = await agent.saveSettings(v.parse(SettingsForm, input));
    acceptState(state);
    return withApplicationState(latestState);
  });
  ipcMain.handle(CHANNEL.testAI, (_event, input: unknown) =>
    agent.testAI(v.parse(SettingsForm, input)),
  );
  ipcMain.handle(CHANNEL.testConfiguration, (_event, input: unknown) =>
    agent.testConfiguration(v.parse(SettingsForm, input)),
  );
  ipcMain.handle(CHANNEL.signIn, () => agent.signIn());
  ipcMain.handle(CHANNEL.signOut, () => agent.signOut());
  ipcMain.handle(CHANNEL.setOpenAtLogin, (_event, enabled: unknown) =>
    setOpenAtLogin(v.parse(v.boolean(), enabled)),
  );

  try {
    await agent.initialize();
    await snapshot(agent);
  } catch (error) {
    log.error(`Balance Agent initialization failed: ${errorText(error)}`);
    acceptState({ error: errorText(error), auth: 'signed_out' });
  }
}

if (!gotLock) app.quit();
else {
  startApplication().catch((error: unknown) => {
    log.error(`Balance Agent startup failed: ${errorText(error)}`);
    app.quit();
  });
}
