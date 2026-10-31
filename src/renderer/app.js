(() => {
  'use strict';

  const api = window.myJira;
  let timeZones = [];
  let state = { tasks: [] };
  let draggedId = null;
  let dragGrabOffset = 0;
  let saveQueue = Promise.resolve();
  let saveSequence = 0;
  let saveStatusTimer = null;
  let appLocked = false;
  let editTaskId = null;

  const $ = (selector) => document.querySelector(selector);

  function setSaveStatus(text, kind = 'normal') {
    const el = $('#saveStatus');
    el.textContent = text;
    el.classList.toggle('pending', kind === 'pending');
    el.classList.toggle('error', kind === 'error');
    clearTimeout(saveStatusTimer);
  }

  function flashSaved() {
    setSaveStatus('Saved automatically');
    saveStatusTimer = setTimeout(() => {
      const el = $('#saveStatus');
      if (el && el.textContent === 'Saved automatically') {
        el.textContent = 'Latest changes saved';
      }
    }, 900);
  }

  function esc(value) {
    return String(value).replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[character]));
  }

  function showMessage(title, text) {
    $('#messageTitle').textContent = title;
    $('#messageText').textContent = text;
    $('#messageModal').classList.add('open');
    $('#messageClose').focus();
  }

  function closeMessage() {
    $('#messageModal').classList.remove('open');
  }

  function setLocked(locked) {
    appLocked = locked;
    $('#inboxInput').disabled = locked;
    $('#inboxForm button[type="submit"]').disabled = locked;
    $('#clearBtn').disabled = locked;
    $('#exportBtn').disabled = locked;
  }

  function buildSchedule() {
    const root = $('#schedule');
    root.innerHTML = '<div class="schedule-grid">' + timeZones.map((zone) => {
      const raw = zone.slice(5);
      const label = raw.slice(0, 2) + ':' + raw.slice(2);
      return `<div class="time-slot"><div class="time-label">${label}</div><div class="slot-drop dropzone" data-zone="${zone}"></div></div>`;
    }).join('') + '<div id="eventsLayer" class="events-layer"></div></div>';
    const today = new Date();
    $('#todayDate').textContent = new Intl.DateTimeFormat('en', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    }).format(today);
  }

  function zoneTasks(zone) {
    return state.tasks.filter((task) => task.zone === zone).sort((a, b) => a.order - b.order);
  }

  function normalize(zone) {
    zoneTasks(zone).forEach((task, index) => {
      task.order = index;
    });
  }

  function save() {
    if (appLocked) {
      setSaveStatus('Tasks file is read-only', 'error');
      return Promise.resolve({ ok: false, error: { code: 'locked' } });
    }

    const snapshot = state.tasks.map((task) => ({ ...task }));
    const sequence = ++saveSequence;
    setSaveStatus('Saving...', 'pending');

    saveQueue = saveQueue.catch(() => {}).then(async () => {
      const result = await api.saveTasks(snapshot);
      if (!result || !result.ok) {
        const message = result && result.error && result.error.message
          ? result.error.message
          : 'The tasks could not be saved.';
        if (sequence === saveSequence) {
          setSaveStatus('Could not save tasks', 'error');
        }
        showMessage('Could not save tasks', message);
        return result || { ok: false, error: { message } };
      }
      if (sequence === saveSequence) {
        flashSaved();
      }
      return result;
    }).catch((error) => {
      if (sequence === saveSequence) {
        setSaveStatus('Could not save tasks', 'error');
      }
      showMessage('Could not save tasks', error && error.message ? error.message : String(error));
      return { ok: false, error: { message: error && error.message ? error.message : String(error) } };
    });

    return saveQueue;
  }

  function addTask(text, zone = 'inbox') {
    const clean = text.trim();
    if (!clean || appLocked) {
      return;
    }
    state.tasks.push({
      id: crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random(),
      text: clean,
      zone,
      order: zoneTasks(zone).length,
      done: false
    });
    save();
    render();
  }

  function move(id, zone, index = null) {
    const task = state.tasks.find((candidate) => candidate.id === id);
    if (!task || appLocked) {
      return;
    }
    const oldZone = task.zone;
    task.zone = zone;
    if (timeZones.includes(zone)) {
      if (!task.duration) {
        task.duration = 15;
      }
    } else {
      delete task.duration;
    }
    normalize(oldZone);
    const destination = zoneTasks(zone).filter((candidate) => candidate.id !== id);
    if (index === null) {
      index = destination.length;
    }
    destination.splice(Math.max(0, Math.min(index, destination.length)), 0, task);
    destination.forEach((candidate, position) => {
      candidate.order = position;
    });
    save();
    render();
  }

  function reorder(id, delta) {
    const task = state.tasks.find((candidate) => candidate.id === id);
    if (!task || appLocked) {
      return;
    }
    const tasks = zoneTasks(task.zone);
    const index = tasks.findIndex((candidate) => candidate.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= tasks.length) {
      return;
    }
    [tasks[index].order, tasks[target].order] = [tasks[target].order, tasks[index].order];
    save();
    render();
  }

  function timeLabel(zone) {
    const raw = zone.slice(5);
    return raw.slice(0, 2) + ':' + raw.slice(2);
  }

  function endLabel(zone, duration) {
    const raw = zone.slice(5);
    const start = Number(raw.slice(0, 2)) * 60 + Number(raw.slice(2));
    const end = Math.min(1020, start + duration);
    return String(Math.floor(end / 60)).padStart(2, '0') + ':' + String(end % 60).padStart(2, '0');
  }

  function durationLabel(minutes) {
    return minutes < 60
      ? minutes + ' min'
      : (Math.floor(minutes / 60) + 'h' + (minutes % 60 ? ' ' + minutes % 60 + 'm' : ''));
  }

  function scheduledTaskHTML(task) {
    const duration = Math.max(15, Math.min(600, Number(task.duration) || 15));
    const startIndex = timeZones.indexOf(task.zone);
    const maxDuration = (40 - startIndex) * 15;
    const safeDuration = Math.min(duration, maxDuration);
    task.duration = safeDuration;
    const top = startIndex * 48 + 3;
    const height = Math.max(46, safeDuration / 15 * 48 - 6);
    return `<article class="task schedule-event ${task.done ? 'done' : ''}" draggable="true" data-id="${esc(task.id)}" style="top:${top}px;height:${height}px"><span class="handle" title="Drag task" aria-hidden="true">⋮⋮</span><span class="task-text" data-full-text="${esc(task.text)}">${esc(task.text)}<span class="event-meta">${timeLabel(task.zone)}–${endLabel(task.zone, safeDuration)} · ${durationLabel(safeDuration)}</span></span><span class="actions"><button class="small" data-act="done" title="Complete">${task.done ? '↶' : '✓'}</button><button class="small move" data-act="inbox" title="Return to list">List</button><button class="small" data-act="edit" title="Edit task">Edit</button><button class="small danger" data-act="delete" title="Delete">×</button></span><button type="button" class="edge-resize top" data-resize="top" title="Drag the top edge to change the start time" aria-label="Resize task from top edge"></button><button type="button" class="edge-resize bottom" data-resize="bottom" title="Drag the bottom edge to change the end time" aria-label="Resize task from bottom edge"></button></article>`;
  }

  function taskHTML(task) {
    return `<article class="task ${task.done ? 'done' : ''}" draggable="true" data-id="${esc(task.id)}"><span class="handle" title="Drag" aria-hidden="true">⋮⋮</span><span class="task-text">${esc(task.text)}</span><span class="actions"><button class="small" data-act="done" title="Complete" aria-label="Mark as ${task.done ? 'pending' : 'completed'}">${task.done ? '↶' : '✓'}</button><button class="small" data-act="up" title="Move up">↑</button><button class="small" data-act="down" title="Move down">↓</button>${task.zone !== 'inbox' ? '<button class="small move" data-act="inbox" title="Return to list">List</button>' : ''}<button class="small" data-act="edit" title="Edit task">Edit</button><button class="small danger" data-act="delete" title="Delete">×</button></span></article>`;
  }

  function render() {
    ['inbox', 'q1', 'q2', 'q3', 'q4'].forEach((zone) => {
      const element = document.getElementById(zone);
      if (element) {
        element.innerHTML = zoneTasks(zone).map(taskHTML).join('');
      }
    });

    const scheduled = state.tasks.filter((task) => timeZones.includes(task.zone));
    $('#eventsLayer').innerHTML = scheduled.map(scheduledTaskHTML).join('');
    $('#inboxCount').textContent = zoneTasks('inbox').length;
    $('#matrixCount').textContent = state.tasks.filter((task) => ['q1', 'q2', 'q3', 'q4'].includes(task.zone)).length;
    $('#scheduleCount').textContent = scheduled.length;
    bindTasks();
  }

  function openEdit(task) {
    editTaskId = task.id;
    $('#editInput').value = task.text;
    $('#editError').hidden = true;
    $('#editError').textContent = '';
    $('#editModal').classList.add('open');
    $('#editInput').focus();
    $('#editInput').select();
  }

  function closeEdit() {
    editTaskId = null;
    $('#editModal').classList.remove('open');
    $('#editError').hidden = true;
  }

  function bindTasks() {
    document.querySelectorAll('.task').forEach((element) => {
      element.addEventListener('dragstart', (event) => {
        if (element.classList.contains('resizing')) {
          event.preventDefault();
          return;
        }
        draggedId = element.dataset.id;
        dragGrabOffset = element.classList.contains('schedule-event')
          ? Math.max(0, event.clientY - element.getBoundingClientRect().top)
          : 0;
        element.classList.add('dragging');
      });

      element.addEventListener('dragend', () => {
        draggedId = null;
        element.classList.remove('dragging');
        document.querySelectorAll('.drop-active').forEach((dropTarget) => {
          dropTarget.classList.remove('drop-active');
        });
      });

      element.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (!button || button.dataset.resize) {
          return;
        }
        const id = element.dataset.id;
        const task = state.tasks.find((candidate) => candidate.id === id);
        if (!task) {
          return;
        }
        if (button.dataset.act === 'done') {
          task.done = !task.done;
          save();
          render();
        }
        if (button.dataset.act === 'up') {
          reorder(id, -1);
        }
        if (button.dataset.act === 'down') {
          reorder(id, 1);
        }
        if (button.dataset.act === 'inbox') {
          move(id, 'inbox');
        }
        if (button.dataset.act === 'edit') {
          openEdit(task);
        }
        if (button.dataset.act === 'delete') {
          state.tasks = state.tasks.filter((candidate) => candidate.id !== id);
          normalize(task.zone);
          save();
          render();
        }
      });

      element.querySelectorAll('.edge-resize').forEach((resizeHandle) => {
        resizeHandle.addEventListener('pointerdown', (event) => startResize(event, element, resizeHandle.dataset.resize));
      });

      const text = element.querySelector('.task-text[data-full-text]');
      if (text) {
        text.addEventListener('mouseenter', (event) => showTaskTooltip(event, text.dataset.fullText));
        text.addEventListener('mousemove', positionTaskTooltip);
        text.addEventListener('mouseleave', hideTaskTooltip);
      }
    });
  }

  function showTaskTooltip(event, text) {
    const tooltip = $('#taskTooltip');
    tooltip.textContent = text;
    tooltip.classList.add('visible');
    positionTaskTooltip(event);
  }

  function positionTaskTooltip(event) {
    const tooltip = $('#taskTooltip');
    if (!tooltip.classList.contains('visible')) {
      return;
    }
    const gap = 14;
    let x = event.clientX + gap;
    let y = event.clientY + gap;
    const rectangle = tooltip.getBoundingClientRect();
    if (x + rectangle.width > window.innerWidth - 8) {
      x = event.clientX - rectangle.width - gap;
    }
    if (y + rectangle.height > window.innerHeight - 8) {
      y = event.clientY - rectangle.height - gap;
    }
    tooltip.style.left = Math.max(8, x) + 'px';
    tooltip.style.top = Math.max(8, y) + 'px';
  }

  function hideTaskTooltip() {
    $('#taskTooltip').classList.remove('visible');
  }

  function startResize(event, element, edge) {
    event.preventDefault();
    event.stopPropagation();
    hideTaskTooltip();
    const task = state.tasks.find((candidate) => candidate.id === element.dataset.id);
    if (!task) {
      return;
    }
    element.classList.add('resizing');
    element.draggable = false;
    const startY = event.clientY;
    const originalIndex = timeZones.indexOf(task.zone);
    const originalDuration = Number(task.duration) || 15;
    const originalBlocks = Math.max(1, Math.round(originalDuration / 15));
    const originalEnd = originalIndex + originalBlocks;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);

    const onMove = (moveEvent) => {
      const delta = Math.round((moveEvent.clientY - startY) / 48);
      let newIndex = originalIndex;
      let newBlocks = originalBlocks;
      if (edge === 'bottom') {
        newBlocks = Math.max(1, Math.min(40 - originalIndex, originalBlocks + delta));
      } else {
        newIndex = Math.max(0, Math.min(originalEnd - 1, originalIndex + delta));
        newBlocks = originalEnd - newIndex;
      }
      task.zone = timeZones[newIndex];
      task.duration = newBlocks * 15;
      element.style.top = (newIndex * 48 + 3) + 'px';
      element.style.height = Math.max(46, newBlocks * 48 - 6) + 'px';
      const meta = element.querySelector('.event-meta');
      if (meta) {
        meta.textContent = timeLabel(task.zone) + '–' + endLabel(task.zone, task.duration) + ' · ' + durationLabel(task.duration);
      }
    };

    const onEnd = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
      element.classList.remove('resizing');
      element.draggable = true;
      save();
      render();
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
  }

  function bindDropzones() {
    document.querySelectorAll('.dropzone:not(.slot-drop)').forEach((zone) => {
      zone.addEventListener('dragover', (event) => {
        event.preventDefault();
        zone.classList.add('drop-active');
      });
      zone.addEventListener('dragleave', (event) => {
        if (!zone.contains(event.relatedTarget)) {
          zone.classList.remove('drop-active');
        }
      });
      zone.addEventListener('drop', (event) => {
        event.preventDefault();
        zone.classList.remove('drop-active');
        if (!draggedId) {
          return;
        }
        const destinationZone = zone.dataset.zone;
        const target = event.target.closest('.task');
        const index = target
          ? zoneTasks(destinationZone).findIndex((candidate) => candidate.id === target.dataset.id)
          : zoneTasks(destinationZone).length;
        move(draggedId, destinationZone, index);
      });
    });

    const grid = document.querySelector('.schedule-grid');
    grid.addEventListener('dragover', (event) => {
      event.preventDefault();
      const index = scheduleDropIndex(event, grid);
      document.querySelectorAll('.slot-drop.drop-active').forEach((slot) => {
        slot.classList.remove('drop-active');
      });
      const slot = grid.querySelector(`.slot-drop[data-zone="${timeZones[index]}"]`);
      if (slot) {
        slot.classList.add('drop-active');
      }
    });
    grid.addEventListener('dragleave', (event) => {
      if (!grid.contains(event.relatedTarget)) {
        document.querySelectorAll('.slot-drop.drop-active').forEach((slot) => {
          slot.classList.remove('drop-active');
        });
      }
    });
    grid.addEventListener('drop', (event) => {
      event.preventDefault();
      event.stopPropagation();
      document.querySelectorAll('.slot-drop.drop-active').forEach((slot) => {
        slot.classList.remove('drop-active');
      });
      if (!draggedId) {
        return;
      }
      move(draggedId, timeZones[scheduleDropIndex(event, grid)]);
    });
  }

  function scheduleDropIndex(event, grid) {
    const rectangle = grid.getBoundingClientRect();
    const dragged = state.tasks.find((task) => task.id === draggedId);
    const offset = dragged && timeZones.includes(dragged.zone) ? dragGrabOffset : 0;
    const y = event.clientY - rectangle.top - offset;
    return Math.max(0, Math.min(39, Math.round(y / 48)));
  }

  async function exportTasks() {
    try {
      const result = await api.exportTasks(state.tasks);
      if (result.canceled) {
        return;
      }
      if (!result.ok) {
        showMessage('Could not export tasks', result.error && result.error.message
          ? result.error.message
          : 'The tasks could not be exported.');
        return;
      }
      setSaveStatus('Exported ' + result.count + ' task' + (result.count === 1 ? '' : 's'));
    } catch (error) {
      showMessage('Could not export tasks', error && error.message ? error.message : String(error));
    }
  }

  async function importTasks() {
    try {
      const result = await api.importTasks(state.tasks.length);
      if (result.canceled) {
        return;
      }
      if (!result.ok) {
        showMessage('Could not import tasks', result.error && result.error.message
          ? result.error.message
          : 'The selected file could not be imported.');
        return;
      }
      state = { tasks: result.tasks };
      saveSequence += 1;
      setLocked(false);
      if (result.sourceFilePath) {
        $('#dataFilePath').textContent = 'Source file: ' + result.sourceFilePath;
      }
      setSaveStatus('Imported ' + result.tasks.length + ' task' + (result.tasks.length === 1 ? '' : 's'));
      render();
      if (result.warnings && result.warnings.length) {
        showMessage('Import completed with warnings', result.warnings.join('\n\n'));
      }
    } catch (error) {
      showMessage('Could not import tasks', error && error.message ? error.message : String(error));
    }
  }

  async function loadState() {
    let info;
    try {
      info = await api.getInfo();
      timeZones = Array.isArray(info.timeZones) ? info.timeZones : [];
      if (info.filePath) {
        $('#dataFilePath').textContent = 'Saved to: ' + info.filePath;
      }
    } catch (error) {
      timeZones = [];
      showMessage('Could not start myJira', error && error.message ? error.message : String(error));
    }

    buildSchedule();
    bindDropzones();

    const result = await api.loadTasks();
    if (!result || !result.ok) {
      state = { tasks: [] };
      setLocked(true);
      setSaveStatus('Tasks file could not be loaded', 'error');
      showMessage(
        'Could not load tasks',
        result && result.error && result.error.message
          ? result.error.message
          : 'The tasks file could not be loaded.'
      );
    } else {
      state = { tasks: result.tasks };
      saveSequence += 1;
      setLocked(false);
      setSaveStatus('Saved automatically');
      if (result.warning) {
        showMessage('Tasks file notice', result.warning);
      }
    }

    render();
  }

  $('#inboxForm').addEventListener('submit', (event) => {
    event.preventDefault();
    addTask($('#inboxInput').value);
    $('#inboxInput').value = '';
    $('#inboxInput').focus();
  });

  $('#clearBtn').onclick = () => {
    if (!appLocked) {
      $('#confirmModal').classList.add('open');
    }
  };
  $('#cancelClear').onclick = () => $('#confirmModal').classList.remove('open');
  $('#confirmClear').onclick = () => {
    $('#confirmModal').classList.remove('open');
    if (appLocked) {
      return;
    }
    state = { tasks: [] };
    save();
    render();
  };

  $('#exportBtn').onclick = exportTasks;
  $('#importBtn').onclick = importTasks;

  $('#editForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const task = state.tasks.find((candidate) => candidate.id === editTaskId);
    if (!task) {
      closeEdit();
      return;
    }
    const clean = $('#editInput').value.trim();
    if (!clean) {
      $('#editError').textContent = 'The task cannot be empty.';
      $('#editError').hidden = false;
      return;
    }
    task.text = clean;
    closeEdit();
    save();
    render();
  });
  $('#cancelEdit').onclick = closeEdit;
  $('#messageClose').onclick = closeMessage;

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') {
      return;
    }
    if ($('#editModal').classList.contains('open')) {
      closeEdit();
    } else if ($('#messageModal').classList.contains('open')) {
      closeMessage();
    } else if ($('#confirmModal').classList.contains('open')) {
      $('#confirmModal').classList.remove('open');
    }
  });

  loadState().catch((error) => {
    setSaveStatus('Could not start myJira', 'error');
    showMessage('Could not start myJira', error && error.message ? error.message : String(error));
  });
})();
