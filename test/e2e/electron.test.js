'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

async function makeTempDir(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  });
  return directory;
}

async function launchApp(t, dataDir) {
  const app = await electron.launch({
    args: ['--no-sandbox', PROJECT_ROOT],
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      MYJIRA_DATA_DIR: dataDir,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    },
    timeout: 60000
  });
  t.after(async () => {
    await app.close().catch(() => {});
  });
  const page = await app.firstWindow();
  await page.waitForSelector('#inboxInput');
  await page.waitForFunction(() => {
    const status = document.querySelector('#saveStatus');
    return status && status.textContent !== 'Loading tasks...';
  });
  return { app, page };
}

async function stubDialogs(app, options) {
  await app.evaluate(({ dialog }, config) => {
    if (config.openPath) {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [config.openPath] });
    }
    if (config.savePath) {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: config.savePath });
    }
    dialog.showMessageBox = async () => ({ response: 1 });
  }, options);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForTasksFile(dataDir, predicate, timeout = 8000) {
  const filePath = path.join(dataDir, 'tasks.json');
  const deadline = Date.now() + timeout;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (predicate(raw)) {
        return raw;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }

  throw new Error('Timed out waiting for tasks.json. ' + (lastError ? lastError.message : ''));
}

async function waitForFile(filePath, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
      await delay(50);
    }
  }
  throw new Error('Timed out waiting for ' + filePath);
}

async function addTask(page, text) {
  const count = await page.locator('#inbox .task').count();
  await page.fill('#inboxInput', text);
  await page.click('#inboxForm button[type="submit"]');
  await page.waitForFunction((expected) => {
    return document.querySelectorAll('#inbox .task').length === expected;
  }, count + 1);
}

test('creates, edits, completes, deletes, and persists tasks across relaunch', async (t) => {
  const dataDir = await makeTempDir(t, 'myjira-e2e-crud-');
  const first = await launchApp(t, dataDir);

  await addTask(first.page, 'Alpha');
  await addTask(first.page, 'Beta');
  assert.equal(await first.page.locator('#inboxCount').textContent(), '2');

  const alpha = first.page.locator('#inbox .task', { hasText: 'Alpha' }).first();
  await alpha.locator('button[data-act="edit"]').click();
  await first.page.waitForSelector('#editModal.open');
  assert.equal(await first.page.inputValue('#editInput'), 'Alpha');
  await first.page.fill('#editInput', 'Alpha edited');
  await first.page.click('#editForm button[type="submit"]');
  await first.page.waitForFunction(() => !document.querySelector('#editModal').classList.contains('open'));
  await first.page.waitForFunction(() => {
    return Array.from(document.querySelectorAll('#inbox .task-text')).some((element) => {
      return element.textContent === 'Alpha edited';
    });
  });

  await first.page.locator('#inbox .task', { hasText: 'Alpha edited' })
    .locator('button[data-act="edit"]').click();
  await first.page.fill('#editInput', '   ');
  await first.page.click('#editForm button[type="submit"]');
  assert.equal(await first.page.locator('#editError').textContent(), 'The task cannot be empty.');
  await first.page.click('#cancelEdit');

  await first.page.locator('#inbox .task', { hasText: 'Beta' })
    .locator('button[data-act="done"]').click();
  await first.page.waitForFunction(() => {
    const task = Array.from(document.querySelectorAll('#inbox .task')).find((element) => {
      return element.textContent.includes('Beta');
    });
    return task && task.classList.contains('done');
  });

  await first.page.locator('#inbox .task', { hasText: 'Beta' })
    .locator('button[data-act="delete"]').click();
  await first.page.waitForFunction(() => document.querySelectorAll('#inbox .task').length === 1);

  const stored = await waitForTasksFile(dataDir, (raw) => {
    return raw.tasks.length === 1 && raw.tasks[0].text === 'Alpha edited';
  });
  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.tasks[0].done, false);

  await first.app.close();

  const second = await launchApp(t, dataDir);
  assert.equal(await second.page.locator('#inbox .task').count(), 1);
  assert.equal(await second.page.locator('#inbox .task-text').textContent(), 'Alpha edited');
  assert.equal(await second.page.locator('#inbox .task.done').count(), 0);
  await second.app.close();
});

test('imports, exports, rejects invalid files, and transfers tasks between data directories', async (t) => {
  const dataDir = await makeTempDir(t, 'myjira-e2e-import-');
  const otherDataDir = await makeTempDir(t, 'myjira-e2e-other-os-');
  const filesDir = await makeTempDir(t, 'myjira-e2e-files-');
  const first = await launchApp(t, dataDir);
  await addTask(first.page, 'Local task');

  const importPath = path.join(filesDir, 'import.json');
  const importedTasks = [
    {
      id: 'unicode',
      text: 'Añadir reunión 🚀',
      zone: 'q2',
      order: 0,
      done: false
    },
    {
      id: 'meeting',
      text: 'Scheduled work',
      zone: 'time-0900',
      order: 0,
      done: true,
      duration: 60
    }
  ];
  await fs.writeFile(importPath, JSON.stringify({
    schemaVersion: 1,
    app: 'myJira',
    updatedAt: '2026-01-02T03:04:05.000Z',
    tasks: importedTasks
  }, null, 2), 'utf8');

  await stubDialogs(first.app, { openPath: importPath });
  await first.page.click('#importBtn');
  await first.page.waitForFunction(() => {
    return document.querySelectorAll('#q2 .task').length === 1 &&
      document.querySelectorAll('.schedule-event').length === 1 &&
      document.querySelectorAll('#inbox .task').length === 0;
  });

  assert.equal(await first.page.locator('#q2 .task-text').textContent(), 'Añadir reunión 🚀');
  assert.equal(await first.page.locator('.schedule-event .task-text').textContent(), 'Scheduled work09:00–10:00 · 1h');
  assert.equal(await first.page.locator('.schedule-event').getAttribute('class'), 'task schedule-event done');

  const stored = await waitForTasksFile(dataDir, (raw) => raw.tasks.length === 2);
  assert.deepEqual(stored.tasks, importedTasks);
  const dataFiles = await fs.readdir(dataDir);
  const preImport = dataFiles.find((file) => file.startsWith('tasks.pre-import-'));
  assert.ok(preImport);
  const preImportData = JSON.parse(await fs.readFile(path.join(dataDir, preImport), 'utf8'));
  assert.equal(preImportData.tasks[0].text, 'Local task');

  const exportPath = path.join(filesDir, 'exported-tasks.json');
  await stubDialogs(first.app, { savePath: exportPath });
  await first.page.click('#exportBtn');
  const exportedText = await waitForFile(exportPath);
  const exported = JSON.parse(exportedText);
  assert.equal(exported.schemaVersion, 1);
  assert.deepEqual(exported.tasks, importedTasks);
  assert.match(exported.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

  const invalidPath = path.join(filesDir, 'invalid.json');
  await fs.writeFile(invalidPath, JSON.stringify({
    schemaVersion: 1,
    tasks: [{ id: 'bad', text: '', zone: 'inbox', order: 0, done: false }]
  }), 'utf8');
  await stubDialogs(first.app, { openPath: invalidPath });
  await first.page.click('#importBtn');
  await first.page.waitForSelector('#messageModal.open');
  assert.equal(await first.page.locator('#messageTitle').textContent(), 'Could not import tasks');
  assert.match(await first.page.locator('#messageText').textContent(), /cannot be empty/);
  await first.page.click('#messageClose');

  assert.equal(await first.page.locator('#q2 .task').count(), 1);
  const afterInvalid = JSON.parse(await fs.readFile(path.join(dataDir, 'tasks.json'), 'utf8'));
  assert.deepEqual(afterInvalid.tasks, importedTasks);

  await first.app.close();

  const second = await launchApp(t, otherDataDir);
  await stubDialogs(second.app, { openPath: exportPath });
  await second.page.click('#importBtn');
  await second.page.waitForFunction(() => {
    return document.querySelectorAll('#q2 .task').length === 1 &&
      document.querySelectorAll('.schedule-event').length === 1;
  });
  assert.equal(await second.page.locator('#q2 .task-text').textContent(), 'Añadir reunión 🚀');
  assert.equal(await second.page.locator('.schedule-event.done').count(), 1);
  const transferred = await waitForTasksFile(otherDataDir, (raw) => raw.tasks.length === 2);
  assert.deepEqual(transferred.tasks, importedTasks);
  await second.app.close();
});

test('imports legacy backups without a schema version and upgrades them', async (t) => {
  const dataDir = await makeTempDir(t, 'myjira-e2e-legacy-');
  const filesDir = await makeTempDir(t, 'myjira-e2e-legacy-files-');
  const { app, page } = await launchApp(t, dataDir);

  const legacyPath = path.join(filesDir, 'old-backup.json');
  await fs.writeFile(legacyPath, JSON.stringify({
    tasks: [
      { id: 'legacy-1', text: 'Legacy inbox item', zone: 'inbox', order: 0, done: false },
      { id: 'legacy-2', text: 'Legacy scheduled item', zone: 'time-1000', order: 0, done: false, duration: 30 }
    ]
  }, null, 2), 'utf8');

  await stubDialogs(app, { openPath: legacyPath });
  await page.click('#importBtn');
  await page.waitForSelector('#messageModal.open');
  assert.equal(await page.locator('#messageTitle').textContent(), 'Import completed with warnings');
  assert.match(await page.locator('#messageText').textContent(), /legacy tasks file was upgraded to schema version 1/);
  await page.click('#messageClose');

  assert.equal(await page.locator('#inbox .task').count(), 1);
  assert.equal(await page.locator('.schedule-event').count(), 1);
  const stored = await waitForTasksFile(dataDir, (raw) => raw.tasks.length === 2);
  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.tasks.find((task) => task.id === 'legacy-2').duration, 30);

  await app.close();
});

test('moves tasks between the list, quadrants, and schedule by drag and drop', async (t) => {
  const dataDir = await makeTempDir(t, 'myjira-e2e-drag-');
  const { app, page } = await launchApp(t, dataDir);
  await addTask(page, 'Draggable task');

  await page.locator('#inbox .task').dragTo(page.locator('.quadrant.q1'));
  await page.waitForFunction(() => document.querySelectorAll('#q1 .task').length === 1);
  assert.equal(await page.locator('#inbox .task').count(), 0);

  await page.locator('#q1 .task').dragTo(page.locator('.slot-drop[data-zone="time-0900"]'));
  await page.waitForFunction(() => document.querySelectorAll('.schedule-event').length === 1);

  const stored = await waitForTasksFile(dataDir, (raw) => {
    return raw.tasks.length === 1 && raw.tasks[0].zone.startsWith('time-');
  });
  assert.equal(stored.tasks[0].duration, 15);
  assert.equal(await page.locator('#scheduleCount').textContent(), '1');

  const resizeHandle = page.locator('.schedule-event .edge-resize.bottom');
  const box = await resizeHandle.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 48, { steps: 5 });
  await page.mouse.up();

  const resized = await waitForTasksFile(dataDir, (raw) => {
    return raw.tasks.length === 1 && raw.tasks[0].duration === 30;
  });
  assert.equal(resized.tasks[0].duration, 30);

  await app.close();
});
