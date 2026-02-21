import { BrowserWindow } from 'electron';
import { getPreloadPath } from './util/paths';

export const createMainWindow = (): BrowserWindow => {
  const win = new BrowserWindow({
    width: 1460,
    height: 920,
    minWidth: 1120,
    minHeight: 700,
    backgroundColor: '#141519',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: getPreloadPath()
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
    if (process.env.OPENVIBEZ_DEVTOOLS === '1') {
      win.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    void win.loadFile('dist/index.html');
  }

  return win;
};
