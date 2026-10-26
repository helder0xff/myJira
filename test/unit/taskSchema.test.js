'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SCHEMA_VERSION,
  TIME_ZONES,
  TaskFileError,
  normalizeTasks,
  parseTaskFile,
  serializeTaskFile
} = require('../../src/shared/taskSchema');

function makeIdFactory() {
  let next = 0;
  return () => 'generated-' + (++next);
}

test('time zones cover 07:00 through 16:45 in 15-minute steps', () => {
  assert.equal(TIME_ZONES.length, 40);
  assert.equal(TIME_ZONES[0], 'time-0700');
  assert.equal(TIME_ZONES[7], 'time-0845');
  assert.equal(TIME_ZONES[39], 'time-1645');
});

test('parses the current schema and preserves unicode text', () => {
  const source = {
    schemaVersion: 1,
    app: 'myJira',
    updatedAt: '2026-01-01T00:00:00.000Z',
    tasks: [
      { id: 'a', text: 'Skriv møtenotat ✓', zone: 'inbox', order: 0, done: false },
      { id: 'b', text: 'Planlæg ugen', zone: 'time-0900', order: 0, done: true, duration: 60 }
    ]
  };

  const parsed = parseTaskFile(JSON.stringify(source), { idFactory: makeIdFactory() });
  assert.equal(parsed.sourceSchemaVersion, 1);
  assert.equal(parsed.legacy, false);
  assert.equal(parsed.tasks.length, 2);
  assert.equal(parsed.tasks[0].text, 'Skriv møtenotat ✓');
  assert.equal(parsed.tasks[1].duration, 60);
});

test('accepts a legacy backup without schemaVersion and fills defaults', () => {
  const legacy = {
    tasks: [
      { id: 'one', text: 'Old task', zone: 'inbox', order: 3, done: false },
      { id: 'two', text: 'Old scheduled task', zone: 'time-1000', order: 0 }
    ]
  };

  const parsed = parseTaskFile(JSON.stringify(legacy), { idFactory: makeIdFactory() });
  assert.equal(parsed.legacy, true);
  assert.equal(parsed.sourceSchemaVersion, 0);
  assert.equal(parsed.tasks[0].order, 0);
  assert.equal(parsed.tasks[1].done, false);
  assert.equal(parsed.tasks[1].duration, 15);
});

test('preserves legacy task text longer than the new-task input limit', () => {
  const longText = 'Long legacy text '.repeat(30);
  const parsed = parseTaskFile(JSON.stringify({
    tasks: [{ id: 'long', text: longText, zone: 'inbox', order: 0, done: false }]
  }), { idFactory: makeIdFactory() });

  assert.equal(parsed.tasks[0].text, longText.trim());
});

test('accepts a bare task array as a legacy format', () => {
  const parsed = parseTaskFile(JSON.stringify([
    { id: 'one', text: 'Bare array', zone: 'q1', order: 0, done: true }
  ]), { idFactory: makeIdFactory() });

  assert.equal(parsed.legacy, true);
  assert.equal(parsed.tasks.length, 1);
});

test('generates ids for legacy tasks without ids and repairs duplicates', () => {
  const source = {
    tasks: [
      { text: 'No id', zone: 'inbox', order: 0 },
      { id: 'duplicate', text: 'First', zone: 'inbox', order: 1 },
      { id: 'duplicate', text: 'Second', zone: 'inbox', order: 2 }
    ]
  };

  const parsed = parseTaskFile(JSON.stringify(source), { idFactory: makeIdFactory() });
  const ids = parsed.tasks.map((task) => task.id);
  assert.equal(new Set(ids).size, 3);
  assert.ok(parsed.warnings.length >= 2);
});

test('normalizes ordering per zone and clamps durations to the schedule', () => {
  const tasks = normalizeTasks([
    { id: 'a', text: 'Late', zone: 'q1', order: 9, done: false },
    { id: 'b', text: 'First', zone: 'q1', order: 1, done: false },
    { id: 'c', text: 'Last slot', zone: 'time-1645', order: 0, done: false, duration: 120 },
    { id: 'd', text: 'Rounded', zone: 'time-0700', order: 0, done: false, duration: 31 }
  ]);

  assert.deepEqual(
    tasks.filter((task) => task.zone === 'q1').sort((a, b) => a.order - b.order).map((task) => task.text),
    ['First', 'Late']
  );
  assert.equal(tasks.find((task) => task.id === 'c').duration, 15);
  assert.equal(tasks.find((task) => task.id === 'd').duration, 30);
});

test('round-trips through serialization with schema metadata', () => {
  const tasks = normalizeTasks([
    { id: 'a', text: 'Payroll', zone: 'q2', order: 0, done: false },
    { id: 'b', text: 'Deep work', zone: 'time-0800', order: 0, done: true, duration: 120 }
  ]);
  const text = serializeTaskFile(tasks, { now: () => new Date('2026-02-03T04:05:06.007Z') });
  const raw = JSON.parse(text);

  assert.equal(raw.schemaVersion, SCHEMA_VERSION);
  assert.equal(raw.app, 'myJira');
  assert.equal(raw.updatedAt, '2026-02-03T04:05:06.007Z');
  assert.equal(raw.tasks.length, 2);
  assert.ok(text.endsWith('\n'));

  const parsed = parseTaskFile(text);
  assert.deepEqual(parsed.tasks, tasks);
});

test('rejects invalid JSON, structures, and values without throwing unexpected errors', () => {
  assert.throws(() => parseTaskFile('{'), (error) => error instanceof TaskFileError && error.code === 'invalid-json');
  assert.throws(() => parseTaskFile(''), (error) => error instanceof TaskFileError && error.code === 'invalid-json');
  assert.throws(() => parseTaskFile('{"nope":[]}'), (error) => error instanceof TaskFileError && error.code === 'invalid-structure');
  assert.throws(() => parseTaskFile('{"tasks":{}}'), (error) => error instanceof TaskFileError && error.code === 'invalid-structure');
  assert.doesNotThrow(() => parseTaskFile('{"tasks":[]}'));

  const invalidTask = (task) => parseTaskFile(JSON.stringify({ schemaVersion: 1, tasks: [task] }), {
    idFactory: makeIdFactory()
  });

  assert.throws(() => invalidTask({ text: '', zone: 'inbox', order: 0 }), /cannot be empty/);
  assert.throws(() => invalidTask({ text: 'x'.repeat(10001), zone: 'inbox', order: 0 }), /longer than 10000/);
  assert.throws(() => invalidTask({ text: 'x', zone: 'time-9999', order: 0 }), /zone is not recognized/);
  assert.throws(() => invalidTask({ text: 'x', zone: 'inbox', order: 0, done: 'yes' }), /completion flag/);
  assert.throws(() => invalidTask({ text: 'x', zone: 'time-0700', order: 0, duration: 'long' }), /duration must be a number/);
});

test('rejects files created by a newer schema with an actionable error', () => {
  assert.throws(
    () => parseTaskFile(JSON.stringify({ schemaVersion: 2, tasks: [] })),
    (error) => error instanceof TaskFileError &&
      error.code === 'future-schema' &&
      error.details[0].schemaVersion === 2
  );
});
