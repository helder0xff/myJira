'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTaskStore } = require('../../src/main/taskStore');

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
  return {
    root,
    store: createTaskStore({
      dataDir: root,
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

  const imported = [{ id: 'imported', text: 'Imported task', zone: 'q4', order: 0, done: false }];
  const result = await store.replaceWithImported(imported);

  assert.equal(result.ok, true);
  assert.equal(result.tasks.length, 1);
  assert.ok(result.preImportPath);
  const backup = JSON.parse(await fs.readFile(result.preImportPath, 'utf8'));
  assert.equal(backup.tasks.length, 2);

  const loaded = await store.load();
  assert.deepEqual(loaded.tasks, imported);
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

  await store.replaceWithImported(sampleTasks);
  assert.equal(store.isLocked(), false);
  const loaded = await store.load();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.tasks.length, 2);
});

test('exports portable JSON that can be read back without modification', async (t) => {
  const { root, store } = await makeStore(t);
  const exportedPath = path.join(root, 'exports', 'myjira-tasks.json');
  const exported = await store.exportToFile(exportedPath, sampleTasks);

  assert.equal(exported.ok, true);
  assert.equal(exported.count, 2);
  const raw = JSON.parse(await fs.readFile(exportedPath, 'utf8'));
  assert.equal(raw.schemaVersion, 1);
  assert.deepEqual(raw.tasks, sampleTasks);

  const imported = await store.readImportFile(exportedPath);
  assert.deepEqual(imported.tasks, sampleTasks);
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
