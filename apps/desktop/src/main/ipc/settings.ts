import { ipcMain } from 'electron';
import { getSetting, setSetting } from '../services/db';
import { getUsageSummary } from '../services/usage';
import { settingsGetSchema, settingsSetSchema, usageSummarySchema } from './contracts';

export const registerSettingsHandlers = (): void => {
  ipcMain.handle('settings:get', (_event, input) => {
    const parsed = settingsGetSchema.parse(input);
    return getSetting(parsed.key);
  });

  ipcMain.handle('settings:set', (_event, input) => {
    const parsed = settingsSetSchema.parse(input);
    setSetting(parsed.key, parsed.value);
    return { ok: true };
  });

  ipcMain.handle('usage:summary', (_event, input) => {
    const parsed = usageSummarySchema.parse(input);
    return getUsageSummary(parsed.days);
  });
};
