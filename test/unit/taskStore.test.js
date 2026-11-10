'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LAST_FILE_SETTINGS_NAME, createTaskStore, readLastFile } = require('../../src/main/taskStore');

function makeIdFactory() {
  let next = 0;
  return () => 'generated-' + (++next);
}

async function makeStore(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'myjira-store-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 12, 0, 0, tick++));
  const settingsFile = path.join(root, LAST_FILE_SETTINGS_NAME);
  return {
    root,
    settingsFile,
    store: createTaskStore({
      dataDir: root,
      settingsFile,
      idFactory: makeIdFactory(),
      now
    })
  };
}

const sampleTasks = [
  { id: 'a', text: 'First task', zone: 'inbox', order: 0, done: false },
  { id: 'b', text: 'Scheduled task', zone: 'time-0900', order: 0, done: true, duration: 45 }
];

test('starts empty when no tasks file exists and does not create one', async (t) => {
  const { root, store } = await makeStore(t);
  const result = await store.load();

  assert.equal(result.ok, true);
  assert.deepEqual(result.tasks, []);
  assert.equal(result.firstRun, true);
  await assert.rejects(fs.access(path.join(root, 'tasks.json')));
});

test('saves and reloads tasks with schema metadata', async (t) => {
  const { root, store } = await makeStore(t);
  const saved = await store.save(sampleTasks);
  assert.equal(saved.ok, true);

  const text = await fs.readFile(path.join(root, 'tasks.json'), 'utf8');
  const raw = JSON.parse(text);
  assert.equal(raw.schemaVersion, 1);
  assert.equal(raw.app, 'myJira');
  assert.equal(raw.tasks.length, 2);

  const loaded = await store.load();
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.tasks, saved.tasks);
});

test('keeps the previous file in tasks.json.bak on subsequent saves', async (t) => {
  const { root, store } = await makeStore(t);
  await store.save(sampleTasks);

  const updated = [sampleTasks[0]];
  await store.save(updated);

  const backup = JSON.parse(await fs.readFile(path.join(root, 'tasks.json.bak'), 'utf8'));
  assert.equal(backup.tasks.length, 2);
  assert.equal(backup.tasks[0].text, 'First task');
});

test('recovers a corrupt tasks file from its backup and preserves the corrupt copy', async (t) => {
  const { root, store } = await makeStore(t);
  await store.save(sampleTasks);
  await store.save([sampleTasks[0]]);

  await fs.writeFile(path.join(root, 'tasks.json'), '{ this is not json', 'utf8');
  const loaded = await store.load();

  assert.equal(loaded.ok, true);
  assert.equal(loaded.recoveredFromBackup, true);
  assert.equal(loaded.tasks.length, 2);
  assert.match(loaded.warning, /restored from its backup/);

  const files = await fs.readdir(root);
  assert.ok(files.some((file) => file.startsWith('tasks.corrupt-')));
  assert.doesNotThrow(() => JSON.parse(loaded.tasks ? JSON.stringify(loaded.tasks) : ''));
  const repaired = JSON.parse(await fs.readFile(path.join(root, 'tasks.json'), 'utf8'));
  assert.equal(repaired.tasks.length, 2);
});

test('starts empty but preserves the damaged file when no backup is usable', async (t) => {
  const { root, store } = await makeStore(t);
  const corrupt = '{ definitely broken';
  await fs.writeFile(path.join(root, 'tasks.json'), corrupt, 'utf8');

  const loaded = await store.load();
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.tasks, []);
  assert.match(loaded.warning, /started with an empty list/);

  const files = await fs.readdir(root);
  const corruptFile = files.find((file) => file.startsWith('tasks.corrupt-'));
  assert.ok(corruptFile);
  assert.equal(await fs.readFile(path.join(root, corruptFile), 'utf8'), corrupt);
});

test('locks saves when the tasks file uses a newer schema', async (t) => {
  const { root, store } = await makeStore(t);
  const original = JSON.stringify({ schemaVersion: 2, tasks: [{ id: 'x', text: 'Future' }] });
  await fs.writeFile(path.join(root, 'tasks.json'), original, 'utf8');

  const loaded = await store.load();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.locked, true);
  assert.equal(loaded.error.code, 'future-schema');
  assert.equal(store.isLocked(), true);
  await assert.rejects(store.save(sampleTasks), (error) => error.code === 'future-schema');
  assert.equal(await fs.readFile(path.join(root, 'tasks.json'), 'utf8'), original);
});

test('reads legacy imports and rejects invalid files without touching stored data', async (t) => {
  const { root, store } = await makeStore(t);
  await store.save(sampleTasks);
  const before = await fs.readFile(path.join(root, 'tasks.json'), 'utf8');

  const legacyPath = path.join(root, 'legacy-export.json');
  await fs.writeFile(legacyPath, JSON.stringify({
    tasks: [{ id: 'legacy', text: 'Legacy backup', zone: 'q3', order: 0, done: false }]
  }), 'utf8');
  const legacy = await store.readImportFile(legacyPath);
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.tasks[0].text, 'Legacy backup');

  const invalidPath = path.join(root, 'invalid.json');
  await fs.writeFile(invalidPath, JSON.stringify({ schemaVersion: 1, tasks: [{ text: '' }] }), 'utf8');
  await assert.rejects(store.readImportFile(invalidPath), /cannot be empty/);

  assert.equal(await fs.readFile(path.join(root, 'tasks.json'), 'utf8'), before);
  const loaded = await store.load();
  assert.equal(loaded.tasks.length, 2);
});

test('replaces tasks from an import and keeps a timestamped pre-import copy', async (t) => {
  const { root, store } = await makeStore(t);
  await store.save(sampleTasks);

  const importPath = path.join(root, 'shared', 'import.json');
  await fs.mkdir(path.dirname(importPath), { recursive: true });
  const originalTasks = [{ id: 'imported', text: 'Imported task', zone: 'q4', order: 0, done: false }];
  await fs.writeFile(importPath, JSON.stringify({
    schemaVersion: 1,
    app: 'myJira',
    updatedAt: '2026-02-02T00:00:00.000Z',
    tasks: originalTasks
  }), 'utf8');

  const parsed = await store.readImportFile(importPath);
  const result = await store.adoptImportedFile(importPath, parsed.tasks);

  assert.equal(result.ok, true);
  assert.equal(result.tasks.length, 1);
  assert.equal(store.paths.dataFile, importPath);
  assert.ok(result.preImportPath);

  // The pre-import copy holds the original content of the imported file.
  const preImport = JSON.parse(await fs.readFile(result.preImportPath, 'utf8'));
  assert.deepEqual(preImport.tasks, originalTasks);
  assert.equal(preImport.updatedAt, '2026-02-02T00:00:00.000Z');

  // The imported file itself now holds the normalized tasks.
  const written = JSON.parse(await fs.readFile(importPath, 'utf8'));
  assert.equal(written.schemaVersion, 1);
  assert.deepEqual(written.tasks, result.tasks);

  // The previous default tasks file is left untouched.
  const internal = JSON.parse(await fs.readFile(path.join(root, 'tasks.json'), 'utf8'));
  assert.equal(internal.tasks.length, 2);

  // Reloading reads from the adopted file, and saves keep going to it.
  const loaded = await store.load();
  assert.equal(loaded.filePath, importPath);
  assert.deepEqual(loaded.tasks, result.tasks);
  await store.save([result.tasks[0]]);
  const savedAgain = JSON.parse(await fs.readFile(importPath, 'utf8'));
  assert.equal(savedAgain.tasks.length, 1);
});

test('unlocks saves after a successful import over a newer-schema file', async (t) => {
  const { root, store } = await makeStore(t);
  await fs.writeFile(
    path.join(root, 'tasks.json'),
    JSON.stringify({ schemaVersion: 99, tasks: [] }),
    'utf8'
  );
  await store.load();
  assert.equal(store.isLocked(), true);

  const importPath = path.join(root, 'replacement.json');
  await store.adoptImportedFile(importPath, sampleTasks);
  assert.equal(store.isLocked(), false);
  const loaded = await store.load();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.tasks.length, 2);
  assert.equal(loaded.filePath, importPath);
});

test('exports portable JSON that can be read back without modification', async (t) => {
  const { root, store } = await makeStore(t);
  const exportedPath = path.join(root, 'exports', 'myjira-tasks.json');
  const exported = await store.exportToFile(exportedPath, sampleTasks);

  assert.equal(exported.ok, true);
  assert.equal(exported.count, 2);
  assert.equal(store.paths.dataFile, exportedPath);
  const raw = JSON.parse(await fs.readFile(exportedPath, 'utf8'));
  assert.equal(raw.schemaVersion, 1);
  assert.deepEqual(raw.tasks, sampleTasks);

  const imported = await store.readImportFile(exportedPath);
  assert.deepEqual(imported.tasks, sampleTasks);
});

test('remembers the exported file and reopens it on the next session', async (t) => {
  const { root, settingsFile, store } = await makeStore(t);
  const exportedPath = path.join(root, 'exports', 'myjira-tasks.json');
  await store.exportToFile(exportedPath, sampleTasks);

  // The settings file recorded the export destination.
  const settings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  assert.equal(settings.file, exportedPath);
  assert.equal(readLastFile(settingsFile), exportedPath);

  // A fresh store (next app launch) resolves the remembered file and loads it.
  const reopened = createTaskStore({
    dataDir: root,
    settingsFile,
    currentFile: readLastFile(settingsFile)
  });
  const loaded = await reopened.load();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.firstRun, undefined);
  assert.equal(loaded.filePath, exportedPath);
  assert.deepEqual(loaded.tasks, sampleTasks);

  // Saves on the reopened store go back to the remembered file.
  await reopened.save([sampleTasks[0]]);
  const saved = JSON.parse(await fs.readFile(exportedPath, 'utf8'));
  assert.equal(saved.tasks.length, 1);
});

test('falls back to the default file when the remembered file is gone', async (t) => {
  const { root, settingsFile } = await makeStore(t);
  const missing = path.join(root, 'gone', 'old-tasks.json');
  const store = createTaskStore({
    dataDir: root,
    settingsFile,
    currentFile: missing
  });

  const loaded = await store.load();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.filePath, path.join(root, 'tasks.json'));
  assert.match(loaded.warning, /could not be found/);
  assert.deepEqual(loaded.tasks, []);
});

test('keeps .bak backups of an external working file in the data folder', async (t) => {
  const { root, store } = await makeStore(t);
  const working = path.join(root, 'external', 'my-tasks.json');
  await store.exportToFile(working, sampleTasks);
  await store.save([sampleTasks[0]]);

  const files = await fs.readdir(root);
  assert.ok(files.includes('my-tasks.json.bak'));
  const backup = JSON.parse(await fs.readFile(path.join(root, 'my-tasks.json.bak'), 'utf8'));
  assert.equal(backup.tasks.length, 2);
});

test('leaves no temporary files behind after writes', async (t) => {
  const { root, store } = await makeStore(t);
  await store.save(sampleTasks);
  await store.save([sampleTasks[0]]);
  await store.exportToFile(path.join(root, 'export.json'), sampleTasks);

  const files = await fs.readdir(root);
  assert.ok(!files.some((file) => file.endsWith('.tmp')));
});

test('flush waits for queued writes to settle', async (t) => {
  const { root, store } = await makeStore(t);
  const pending = [store.save(sampleTasks), store.save([sampleTasks[0]])];
  await store.flush();
  await Promise.all(pending);

  const raw = JSON.parse(await fs.readFile(path.join(root, 'tasks.json'), 'utf8'));
  assert.equal(raw.tasks.length, 1);
});
