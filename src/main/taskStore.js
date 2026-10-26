'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  TaskFileError,
  normalizeTasks,
  parseTaskFile,
  serializeTaskFile
} = require('../shared/taskSchema');

const TASKS_FILE_NAME = 'tasks.json';
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

class TaskStoreError extends Error {
  constructor(message, code = 'task-store-error', details = []) {
    super(message);
    this.name = 'TaskStoreError';
    this.code = code;
    this.details = details;
  }
}

function timestampForFileName(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function replaceFile(source, destination) {
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (process.platform === 'win32' && ['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) {
      await fs.rm(destination, { force: true });
      await fs.rename(source, destination);
      return;
    }
    throw error;
  }
}

async function writeAtomic(filePath, contents) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    '.' + path.basename(filePath) + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp'
  );

  let handle;
  try {
    handle = await fs.open(temporaryPath, 'w', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await replaceFile(temporaryPath, filePath);
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function createTaskStore(options = {}) {
  const dataDir = path.resolve(options.dataDir);
  const now = options.now || (() => new Date());
  const idFactory = options.idFactory;
  const maxImportBytes = options.maxImportBytes || MAX_IMPORT_BYTES;
  const dataFile = path.join(dataDir, TASKS_FILE_NAME);
  const backupFile = path.join(dataDir, TASKS_FILE_NAME + '.bak');

  let writeQueue = Promise.resolve();
  let lockedReason = null;

  function enqueue(operation) {
    const result = writeQueue.catch(() => {}).then(operation);
    writeQueue = result;
    return result;
  }

  async function copyCurrentFile(destinationName) {
    const destination = path.join(dataDir, destinationName);
    try {
      await fs.copyFile(dataFile, destination);
      return destination;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async function backupExistingData() {
    return copyCurrentFile(path.basename(backupFile));
  }

  async function preserveCorruptFile() {
    const stamp = timestampForFileName(now());
    return copyCurrentFile('tasks.corrupt-' + stamp + '.json');
  }

  async function writeTasksFile(tasks) {
    await fs.mkdir(dataDir, { recursive: true });
    await backupExistingData();
    const currentTime = now();
    const contents = serializeTaskFile(tasks, { now: () => currentTime });
    await writeAtomic(dataFile, contents);
    return {
      ok: true,
      tasks,
      updatedAt: currentTime.toISOString(),
      filePath: dataFile
    };
  }

  async function load() {
    await fs.mkdir(dataDir, { recursive: true });

    let contents;
    try {
      contents = await fs.readFile(dataFile, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return {
          ok: true,
          tasks: [],
          filePath: dataFile,
          warning: null,
          firstRun: true
        };
      }
      lockedReason = {
        code: 'read-failed',
        message: 'The tasks file could not be read: ' + error.message
      };
      return {
        ok: false,
        locked: true,
        error: lockedReason,
        filePath: dataFile
      };
    }

    try {
      const parsed = parseTaskFile(contents, { idFactory });
      return {
        ok: true,
        tasks: parsed.tasks,
        filePath: dataFile,
        warning: null,
        warnings: parsed.warnings,
        legacy: parsed.legacy,
        sourceSchemaVersion: parsed.sourceSchemaVersion
      };
    } catch (error) {
      if (error instanceof TaskFileError && error.code === 'future-schema') {
        lockedReason = {
          code: error.code,
          message: error.message,
          details: error.details
        };
        return {
          ok: false,
          locked: true,
          error: lockedReason,
          filePath: dataFile
        };
      }

      let corruptPath = null;
      try {
        corruptPath = await preserveCorruptFile();
      } catch (copyError) {
        corruptPath = null;
      }

      let backupContents = null;
      try {
        backupContents = await fs.readFile(backupFile, 'utf8');
      } catch (backupError) {
        backupContents = null;
      }

      if (backupContents) {
        try {
          const recovered = parseTaskFile(backupContents, { idFactory });
          await writeAtomic(dataFile, serializeTaskFile(recovered.tasks, { now }));
          return {
            ok: true,
            tasks: recovered.tasks,
            filePath: dataFile,
            warning: 'The tasks file was damaged and has been restored from its backup.' +
              (corruptPath ? '\n\nA copy of the damaged file was kept at:\n' + corruptPath : ''),
            recoveredFromBackup: true,
            corruptPath
          };
        } catch (recoveryError) {
          // Fall through to the empty-state recovery below.
        }
      }

      return {
        ok: true,
        tasks: [],
        filePath: dataFile,
        warning: 'The tasks file could not be read, so myJira started with an empty list.' +
          (corruptPath ? '\n\nThe damaged file was kept at:\n' + corruptPath : '') +
          '\n\nYou can import a backup to restore your tasks.',
        corruptPath
      };
    }
  }

  async function save(tasks) {
    if (lockedReason) {
      throw new TaskStoreError(lockedReason.message, lockedReason.code, lockedReason.details || []);
    }

    const normalized = normalizeTasks(tasks, { idFactory });
    return enqueue(() => writeTasksFile(normalized));
  }

  async function exportToFile(filePath, tasks) {
    const normalized = normalizeTasks(tasks, { idFactory });
    const contents = serializeTaskFile(normalized, { now });
    await writeAtomic(path.resolve(filePath), contents);
    return {
      ok: true,
      filePath: path.resolve(filePath),
      count: normalized.length
    };
  }

  async function readImportFile(filePath) {
    const stats = await fs.stat(filePath);
    if (stats.size > maxImportBytes) {
      throw new TaskStoreError(
        'The selected file is too large. The maximum supported size is ' + Math.round(maxImportBytes / 1024 / 1024) + ' MB.',
        'file-too-large'
      );
    }
    const contents = await fs.readFile(filePath, 'utf8');
    const parsed = parseTaskFile(contents, { idFactory });
    return {
      ...parsed,
      filePath: path.resolve(filePath)
    };
  }

  async function replaceWithImported(tasks) {
    const normalized = normalizeTasks(tasks, { idFactory });

    return enqueue(async () => {
      await fs.mkdir(dataDir, { recursive: true });
      const stamp = timestampForFileName(now());
      const preImportPath = await copyCurrentFile('tasks.pre-import-' + stamp + '.json');
      const result = await writeTasksFile(normalized);
      lockedReason = null;
      return {
        ...result,
        preImportPath
      };
    });
  }

  async function flush() {
    await writeQueue.catch(() => {});
  }

  function isLocked() {
    return Boolean(lockedReason);
  }

  return {
    exportToFile,
    flush,
    isLocked,
    load,
    paths: {
      dataDir,
      dataFile,
      backupFile
    },
    readImportFile,
    replaceWithImported,
    save
  };
}

module.exports = {
  MAX_IMPORT_BYTES,
  TASKS_FILE_NAME,
  TaskStoreError,
  createTaskStore,
  writeAtomic
};
