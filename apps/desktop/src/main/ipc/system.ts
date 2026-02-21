import { ipcMain, shell } from 'electron';
import { openExternalSchema } from './contracts';

export const registerSystemHandlers = (): void => {
  ipcMain.handle('system:openExternal', async (_event, input) => {
    const parsed = openExternalSchema.parse(input);
    await shell.openExternal(parsed.url);
    return { ok: true };
  });
};
