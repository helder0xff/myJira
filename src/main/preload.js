'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('myJira', {
  getInfo: () => ipcRenderer.invoke('app:info'),
  loadTasks: () => ipcRenderer.invoke('tasks:load'),
  saveTasks: (tasks) => ipcRenderer.invoke('tasks:save', tasks),
  exportTasks: (tasks) => ipcRenderer.invoke('tasks:export', tasks),
  importTasks: (currentCount) => ipcRenderer.invoke('tasks:import', currentCount)
});
