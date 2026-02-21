import { app, BrowserWindow } from 'electron';
import { registerIpcHandlers } from './ipc';
import { startJobScheduler } from './jobs/scheduler';
import { initDb } from './services/db';
import { createMainWindow } from './window';
import { logger } from './util/logger';

const bootstrap = async (): Promise<void> => {
  await app.whenReady();

  initDb();
  registerIpcHandlers();
  startJobScheduler();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
};

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

bootstrap().catch((error) => {
  logger.error('Failed to bootstrap OpenVibez', error);
  app.quit();
});
