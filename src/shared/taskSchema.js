'use strict';

const { randomUUID } = require('node:crypto');

const SCHEMA_VERSION = 1;
const APP_ID = 'myJira';
const TASK_TEXT_MAX = 10000;
const DURATION_STEP = 15;
const MIN_DURATION = 15;
const MAX_DURATION = 600;
const BASE_ZONES = Object.freeze(['inbox', 'q1', 'q2', 'q3', 'q4']);
const TIME_ZONES = Object.freeze(Array.from({ length: 40 }, (_, index) => {
  const minutes = 420 + index * 15;
  return 'time-' + String(Math.floor(minutes / 60)).padStart(2, '0') + String(minutes % 60).padStart(2, '0');
}));
const ALL_ZONES = new Set([...BASE_ZONES, ...TIME_ZONES]);

class TaskFileError extends Error {
  constructor(message, code = 'invalid-task-file', details = []) {
    super(message);
    this.name = 'TaskFileError';
    this.code = code;
    this.details = details;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTimeZone(zone) {
  return TIME_ZONES.includes(zone);
}

function invalidTask(index, message) {
  return new TaskFileError('Task ' + (index + 1) + ' is invalid: ' + message, 'invalid-task', [
    { task: index + 1, message }
  ]);
}

function normalizeTasks(tasks, options = {}) {
  if (!Array.isArray(tasks)) {
    throw new TaskFileError('The task list must be an array.', 'invalid-structure');
  }

  const idFactory = options.idFactory || randomUUID;
  const warnings = options.warnings || [];
  const seenIds = new Set();
  const prepared = tasks.map((raw, index) => {
    if (!isPlainObject(raw)) {
      throw invalidTask(index, 'each task must be an object.');
    }

    if (typeof raw.text !== 'string') {
      throw invalidTask(index, 'the text must be a string.');
    }
    const text = raw.text.trim();
    if (!text) {
      throw invalidTask(index, 'the text cannot be empty.');
    }
    if (text.length > TASK_TEXT_MAX) {
      throw invalidTask(index, 'the text cannot be longer than ' + TASK_TEXT_MAX + ' characters.');
    }

    if (typeof raw.zone !== 'string' || !ALL_ZONES.has(raw.zone)) {
      throw invalidTask(index, 'the zone is not recognized.');
    }
    const zone = raw.zone;

    let id;
    if (typeof raw.id === 'string' && raw.id.trim()) {
      id = raw.id.trim();
      if (seenIds.has(id)) {
        id = idFactory();
        warnings.push('Task ' + (index + 1) + ' had a duplicate id; a new id was generated.');
      }
    } else {
      id = idFactory();
      warnings.push('Task ' + (index + 1) + ' had no id; a new id was generated.');
    }
    seenIds.add(id);

    let done = false;
    if (raw.done !== undefined && raw.done !== null) {
      if (typeof raw.done !== 'boolean') {
        throw invalidTask(index, 'the completion flag must be true or false.');
      }
      done = raw.done;
    }

    let order = null;
    if (raw.order !== undefined && raw.order !== null) {
      if (typeof raw.order !== 'number' || !Number.isFinite(raw.order)) {
        throw invalidTask(index, 'the order must be a number.');
      }
      order = raw.order;
    }

    let duration;
    if (isTimeZone(zone)) {
      const startIndex = TIME_ZONES.indexOf(zone);
      const maxDuration = Math.min(MAX_DURATION, (TIME_ZONES.length - startIndex) * DURATION_STEP);
      let requestedDuration = MIN_DURATION;
      if (raw.duration !== undefined && raw.duration !== null) {
        if (typeof raw.duration !== 'number' || !Number.isFinite(raw.duration)) {
          throw invalidTask(index, 'the duration must be a number.');
        }
        requestedDuration = raw.duration;
      }
      duration = Math.round(requestedDuration / DURATION_STEP) * DURATION_STEP;
      duration = Math.max(MIN_DURATION, Math.min(maxDuration, duration));
      if (duration !== requestedDuration) {
        warnings.push('Task ' + (index + 1) + ' had an invalid duration; it was adjusted to ' + duration + ' minutes.');
      }
    }

    return {
      id,
      text,
      zone,
      done,
      order,
      duration,
      index
    };
  });

  const byZone = new Map();
  for (const task of prepared) {
    if (!byZone.has(task.zone)) {
      byZone.set(task.zone, []);
    }
    byZone.get(task.zone).push(task);
  }

  for (const zoneTasks of byZone.values()) {
    zoneTasks.sort((a, b) => {
      const aOrder = a.order === null ? Number.POSITIVE_INFINITY : a.order;
      const bOrder = b.order === null ? Number.POSITIVE_INFINITY : b.order;
      return aOrder - bOrder || a.index - b.index;
    });
    zoneTasks.forEach((task, index) => {
      task.order = index;
    });
  }

  return prepared.map((task) => {
    const normalized = {
      id: task.id,
      text: task.text,
      zone: task.zone,
      order: task.order,
      done: task.done
    };
    if (task.duration !== undefined) {
      normalized.duration = task.duration;
    }
    return normalized;
  });
}

function parseTaskFile(text, options = {}) {
  if (typeof text !== 'string') {
    throw new TaskFileError('The tasks file could not be read as text.', 'invalid-structure');
  }
  if (!text.trim()) {
    throw new TaskFileError('The tasks file is empty.', 'invalid-json');
  }

  let root;
  try {
    root = JSON.parse(text);
  } catch (error) {
    throw new TaskFileError('The tasks file is not valid JSON.', 'invalid-json');
  }

  if (Array.isArray(root)) {
    root = { tasks: root };
  }
  if (!isPlainObject(root)) {
    throw new TaskFileError('The tasks file does not contain a valid task list.', 'invalid-structure');
  }
  if (!Array.isArray(root.tasks)) {
    throw new TaskFileError('The tasks file does not contain a tasks array.', 'invalid-structure');
  }

  let sourceSchemaVersion = 0;
  if (root.schemaVersion !== undefined && root.schemaVersion !== null) {
    if (!Number.isInteger(root.schemaVersion) || root.schemaVersion < 0) {
      throw new TaskFileError('The tasks file has an invalid schema version.', 'invalid-schema');
    }
    if (root.schemaVersion > SCHEMA_VERSION) {
      throw new TaskFileError(
        'This tasks file uses schema version ' + root.schemaVersion +
          ', but this version of myJira supports up to version ' + SCHEMA_VERSION + '. Please update myJira.',
        'future-schema',
        [{ schemaVersion: root.schemaVersion, supportedVersion: SCHEMA_VERSION }]
      );
    }
    sourceSchemaVersion = root.schemaVersion;
  }

  const warnings = [];
  const tasks = normalizeTasks(root.tasks, {
    idFactory: options.idFactory,
    warnings
  });

  return {
    tasks,
    warnings,
    sourceSchemaVersion,
    legacy: sourceSchemaVersion === 0,
    updatedAt: typeof root.updatedAt === 'string' ? root.updatedAt : null
  };
}

function serializeTaskFile(tasksOrState, options = {}) {
  const tasks = Array.isArray(tasksOrState) ? tasksOrState : tasksOrState && tasksOrState.tasks;
  const normalized = normalizeTasks(tasks);
  const now = typeof options.now === 'function' ? options.now() : new Date();
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    app: APP_ID,
    updatedAt: now.toISOString(),
    tasks: normalized
  }, null, 2) + '\n';
}

function emptyTasks() {
  return [];
}

module.exports = {
  APP_ID,
  BASE_ZONES,
  DURATION_STEP,
  MAX_DURATION,
  MIN_DURATION,
  SCHEMA_VERSION,
  TASK_TEXT_MAX,
  TIME_ZONES,
  TaskFileError,
  emptyTasks,
  isTimeZone,
  normalizeTasks,
  parseTaskFile,
  serializeTaskFile
};
