import path from 'node:path';
import { app } from 'electron';

export const getUserDataPath = (): string => app.getPath('userData');

export const getPreloadPath = (): string => path.join(__dirname, '..', '..', 'preload', 'index.js');
