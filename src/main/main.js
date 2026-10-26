'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { TIME_ZONES } = require('../shared/taskSchema');
const { createTaskStore } = require('./taskStore');

const APP_NAME = 'myJira';
const RENDERER_HTML = path.join(__dirname, '..', 'renderer', 'index.html');

app.setName(APP_NAME);

if (process.platform === 'linux' && process.env.APPIMAGE) {
  app.commandLine.appendSwitch('no-sandbox');
}

const userDataDir = process.env.MYJIRA_DATA_DIR
  ? path.join(path.resolve(process.env.MYJIRA_DATA_DIR), '.electron-user-data')
  : path.join(app.getPath('appData'), APP_NAME);
fs.mkdirSync(userDataDir, { recursive: true });
app.setPath('userData', userDataDir);

const taskDataDir = process.env.MYJIRA_DATA_DIR
  ? path.resolve(process.env.MYJIRA_DATA_DIR)
  : path.join(userDataDir, 'data');

let mainWindow = null;
let taskStore = null;
let flushStarted = false;
let allowQuit = false;

function toErrorPayload(error) {
  return {
    code: error && error.code ? error.code : 'error',
    message: error && error.message ? error.message : String(error),
    details: error && Array.isArray(error.details) ? error.details : []
  };
}

function showWindow() {
  if (!mainWindow) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 760,
    minHeight: 560,
    title: 'My Tasks and Eisenhower Matrix',
    backgroundColor: '#eef2f7',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!mainWindow || url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });

  mainWindow.loadFile(RENDERER_HTML).catch((error) => {
    dialog.showErrorBox('myJira could not start', error.message);
  });
}

function registerIpcHandlers() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    filePath: taskStore.paths.dataFile,
    dataDir: taskStore.paths.dataDir,
    timeZones: Array.from(TIME_ZONES)
  }));

  ipcMain.handle('tasks:load', async () => {
    try {
      return await taskStore.load();
    } catch (error) {
      return { ok: false, locked: false, error: toErrorPayload(error) };
    }
  });

  ipcMain.handle('tasks:save', async (_event, tasks) => {
    try {
      return await taskStore.save(tasks);
    } catch (error) {
      return { ok: false, error: toErrorPayload(error) };
    }
  });

  ipcMain.handle('tasks:export', async (_event, tasks) => {
    try {
      const options = {
        title: 'Export tasks',
        defaultPath: path.join(
          app.getPath('documents'),
          'myJira-tasks-' + new Date().toISOString().slice(0, 10) + '.json'
        ),
        filters: [{ name: 'JSON task files', extensions: ['json'] }]
      };
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) {
        return { ok: false, canceled: true };
      }
      return await taskStore.exportToFile(result.filePath, tasks);
    } catch (error) {
      return { ok: false, error: toErrorPayload(error) };
    }
  });

  ipcMain.handle('tasks:import', async (_event, currentCount) => {
    try {
      const options = {
        title: 'Import tasks',
        properties: ['openFile'],
        filters: [{ name: 'JSON task files', extensions: ['json'] }]
      };
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths || !result.filePaths[0]) {
        return { ok: false, canceled: true };
      }

      const parsed = await taskStore.readImportFile(result.filePaths[0]);
      const count = Number.isInteger(currentCount) && currentCount > 0 ? currentCount : 0;
      const locked = taskStore.isLocked();

      if (count > 0 || locked) {
        const detail = locked
          ? 'The current tasks file was created by a newer version of myJira and has not been loaded. Importing will replace it. A timestamped copy of the current file will be kept in the tasks data folder.'
          : 'This will replace all ' + count + ' task' + (count === 1 ? '' : 's') +
              ' currently in myJira with ' + parsed.tasks.length + ' imported task' +
              (parsed.tasks.length === 1 ? '' : 's') +
              '. A timestamped copy of the current tasks file will be kept in the tasks data folder.';
        const confirmation = mainWindow
          ? await dialog.showMessageBox(mainWindow, {
              type: 'warning',
              buttons: ['Cancel', 'Replace tasks'],
              defaultId: 0,
              cancelId: 0,
              title: 'Replace current tasks?',
              message: 'Replace the current task list?',
              detail
            })
          : await dialog.showMessageBox({
              type: 'warning',
              buttons: ['Cancel', 'Replace tasks'],
              defaultId: 0,
              cancelId: 0,
              title: 'Replace current tasks?',
              message: 'Replace the current task list?',
              detail
            });
        if (confirmation.response !== 1) {
          return { ok: false, canceled: true };
        }
      }

      const saved = await taskStore.replaceWithImported(parsed.tasks);
      const warnings = parsed.warnings.slice();
      if (parsed.legacy) {
        warnings.unshift('This legacy tasks file was upgraded to schema version 1.');
      }

      return {
        ok: true,
        tasks: saved.tasks,
        filePath: saved.filePath,
        backupPath: saved.preImportPath,
        sourceSchemaVersion: parsed.sourceSchemaVersion,
        warnings
      };
    } catch (error) {
      return { ok: false, error: toErrorPayload(error) };
    }
  });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });

  app.on('before-quit', (event) => {
    if (!taskStore || allowQuit) {
      return;
    }
    event.preventDefault();
    if (flushStarted) {
      return;
    }
    flushStarted = true;
    Promise.race([
      taskStore.flush(),
      new Promise((resolve) => setTimeout(resolve, 5000))
    ]).finally(() => {
      allowQuit = true;
      app.quit();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (!mainWindow) {
      createWindow();
    } else {
      showWindow();
    }
  });

  app.whenReady().then(() => {
    taskStore = createTaskStore({ dataDir: taskDataDir });
    registerIpcHandlers();
    createWindow();
  }).catch((error) => {
    console.error(error);
    dialog.showErrorBox('myJira could not start', error.message);
    app.quit();
  });
}
