# myJira

A desktop task list and Eisenhower matrix with an optional daily schedule. The original single-file HTML application has been converted to an Electron desktop app for Windows and Debian-based Linux distributions while preserving its interface and behavior.

## Features

- Task inbox with reordering
- Eisenhower matrix with four quadrants
- Drag and drop between the inbox, quadrants, and schedule
- Daily timeline from 07:00 to 17:00 with 15-minute resizing
- Add, edit, complete, delete, and reorder tasks
- Portable, versioned JSON task file
- Native import and export dialogs
- Automatic atomic saves, backups, and corruption recovery
- Legacy backup import from the original HTML version
- Light and dark color schemes following the operating system

## Project layout

```text
src/
  main/
    main.js        Electron lifecycle, windows, IPC, native dialogs
    preload.js     Safe renderer API (contextBridge)
    taskStore.js   File reads/writes, atomic saves, backups, recovery
  shared/
    taskSchema.js  Schema version, validation, legacy migration
  renderer/
    index.html     Application markup
    styles.css     Application styles
    app.js         UI state and interaction logic
test/
  unit/            Schema and storage tests
  e2e/             Electron end-to-end tests
build/             Application icons
```

## Requirements

- Node.js 22.12 or newer and npm (required by Electron 45)
- Linux packaging: AppImage tooling is downloaded automatically by electron-builder
- Windows packaging:
  - Windows host, or
  - Linux with Wine. Wine 11 with `wine32` and `wine64` was used for the verification builds in this repository.
- End-to-end tests need a graphical session (X11 or Wayland). On a headless Linux machine, run them under `xvfb-run`.

## Development

```bash
npm install
npm start
```

On Ubuntu 24.04 or other systems where Chromium's sandbox cannot start from the development tree, use the development-only fallback:

```bash
npm run start:linux
```

That command disables the Chromium sandbox for local development only. The portable AppImage handles this compatibility case automatically.

## Tests

```bash
npm test          # unit tests for schema, validation, storage, backups, recovery
npm run test:e2e  # Electron UI tests for CRUD, drag/drop, import/export, persistence
npm run test:all
```

The end-to-end tests launch Electron with a temporary `MYJIRA_DATA_DIR`, so they do not touch real task data.

## Building the portable executables

```bash
npm run dist:linux   # portable AppImage
npm run dist:win     # portable Windows executable
npm run dist         # both
```

Artifacts are written to `dist/`:

- `myJira-<version>-linux-x86_64.AppImage`
- `myJira-<version>-win-x64-portable.exe`

Both are ready-to-run files with no installation step. The default build scripts clean `dist/` before building.

Unpacked builds are available through:

```bash
npm run pack:linux
npm run pack:win
```

The Windows executable is not code-signed. Windows SmartScreen may warn about an unknown publisher.

### Windows builds from Linux

The portable Windows build was verified with Wine:

```bash
WINEDEBUG=-all npm run dist:win
```

Building the Windows executable and updating its metadata requires Wine. A native Windows machine is the most reliable packaging environment.

## Running the apps

No installation or uninstall step is required.

### Linux

```bash
chmod +x myJira-1.0.0-linux-x86_64.AppImage
./myJira-1.0.0-linux-x86_64.AppImage
```

The AppImage can also be double-clicked after it is marked executable.

If FUSE is unavailable:

```bash
APPIMAGE_EXTRACT_AND_RUN=1 ./myJira-1.0.0-linux-x86_64.AppImage
```

The portable AppImage disables Chromium's sandbox automatically. This is required for reliable startup on Ubuntu 24.04+, where unprivileged AppImages are restricted by AppArmor. The app is local and offline, but this reduces process isolation.

### Windows

Run `myJira-1.0.0-win-x64-portable.exe` directly. It does not install anything; it extracts to a temporary directory and starts the app.

Task data remains in the per-user data directory, so replacing the portable executable with a newer version does not affect tasks.

## Task data

Tasks are stored in one portable JSON file outside the application executable:

| Operating system | Default task file |
| --- | --- |
| Linux | `~/.config/myJira/data/tasks.json` |
| Windows | `%APPDATA%\myJira\data\tasks.json` |

The file is independent of the executable location and application version. Replacing the portable executable with a newer version keeps the same data directory.

### Portable/custom data directory

Set `MYJIRA_DATA_DIR` before launching to place `tasks.json` in a chosen directory:

```bash
MYJIRA_DATA_DIR=/media/usb/myjira ./myJira-1.0.0-linux-x86_64.AppImage
```

For Windows:

```bat
set MYJIRA_DATA_DIR=E:\myjira-data
myJira-1.0.0-win-x64-portable.exe
```

In this mode Electron's internal cache is stored in a `.electron-user-data` subdirectory of the same location, while `tasks.json` remains directly in the selected directory.

### File format

```json
{
  "schemaVersion": 1,
  "app": "myJira",
  "updatedAt": "2026-10-25T12:00:00.000Z",
  "tasks": [
    {
      "id": "7e26b6fd-58e8-4cd8-8c5b-45f40fa4bcc5",
      "text": "Plan the week",
      "zone": "q2",
      "order": 0,
      "done": false
    },
    {
      "id": "1b0fd2db-2a64-43b7-94f6-4cdf2a4ea8c6",
      "text": "Team meeting",
      "zone": "time-0900",
      "order": 0,
      "done": false,
      "duration": 60
    }
  ]
}
```

- `schemaVersion` identifies the data format and is currently `1`.
- `zone` is `inbox`, `q1` through `q4`, or a schedule slot from `time-0700` through `time-1645`.
- `duration` is only meaningful for schedule zones and is expressed in 15-minute steps from 15 to 600 minutes.
- Text is UTF-8, so task files transfer directly between Windows and Linux.
- Internal metadata and operating-system paths are not stored in task entries.

### Saves and recovery

- Saves are written to a temporary file and atomically renamed into place.
- The previous good file is kept as `tasks.json.bak`.
- A damaged live file is preserved as `tasks.corrupt-<timestamp>.json`.
- The app attempts to restore from `tasks.json.bak` when the live file cannot be parsed.
- If the file uses a newer schema version than the app supports, saves are locked rather than overwriting it. Importing a compatible backup replaces it after confirmation and keeps a timestamped copy.
- Writes queued before application exit are flushed before quitting.

## Import and export

Use **Export backup** and **Import backup** in the application footer. Both use native file dialogs.

- Export writes the current task list as versioned JSON.
- Import validates the entire file before changing anything.
- A valid import replaces the current list only after confirmation and keeps `tasks.pre-import-<timestamp>.json`.
- Invalid or incompatible files are rejected with a message; current tasks are not modified.
- The maximum import size is 10 MB.
- The same exported file can be imported on Windows and Linux without conversion.

### Importing legacy backups

Backup files from the original HTML application have no `schemaVersion`. They are accepted as legacy input, normalized, and saved as schema version 1 when imported with **Import backup**.

## Verification performed

- Unit tests: schema validation, legacy migration, ordering/duration normalization, atomic writes, backups, corruption recovery, future-schema locking, import safety.
- Electron end-to-end tests: add, edit, validation, complete, delete, drag between inbox/quadrant/schedule, timeline resize, import, export, invalid import preservation, legacy import, relaunch persistence, and cross-directory transfer.
- Linux: portable AppImage built and launched directly without extra command-line flags; task creation and JSON persistence verified.
- Windows: portable executable built and launched directly under Wine 11; task creation and JSON persistence verified without any installation step.
- Cross-OS data transfer: a Windows-created `tasks.json` was loaded and extended on Linux, then the resulting file was loaded and extended by the Windows build, preserving task text and schema version in both directions.

## Updating the data format

When the task structure changes:

1. Increment `SCHEMA_VERSION` in `src/shared/taskSchema.js`.
2. Add migration logic for older versions before validation.
3. Keep the parser able to read older files.
4. Reject newer versions without overwriting them.
5. Add unit tests for the new migration and round-trip serialization.

## Notes

- Electron keeps the application bundle larger than a browser-only release (roughly 100–120 MB per executable).
- No network access is used by the application. The renderer runs with context isolation, a restrictive Content Security Policy, and no Node.js integration. The portable AppImage disables Chromium's sandbox for Ubuntu 24.04 compatibility.
