import fs from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';
import { createWorkspace, listWorkspaces } from '../services/db';
import { workspaceAddSchema } from './contracts';

const mapWorkspace = (row: {
  id: string;
  name: string;
  root_path: string;
  trust_level: string;
  created_at: number;
  updated_at: number;
  last_opened_at: number | null;
}) => ({
  id: row.id,
  name: row.name,
  rootPath: row.root_path,
  trustLevel: row.trust_level,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastOpenedAt: row.last_opened_at
});

export const registerWorkspaceHandlers = (): void => {
  ipcMain.handle('workspace:add', (_event, input) => {
    const parsed = workspaceAddSchema.parse(input);
    const stat = fs.statSync(parsed.path);
    if (!stat.isDirectory()) {
      throw new Error('Path must be a directory');
    }

    const workspace = createWorkspace({
      name: path.basename(parsed.path),
      rootPath: parsed.path,
      trustLevel: parsed.trustLevel
    });

    return mapWorkspace(workspace);
  });

  ipcMain.handle('workspace:list', () => {
    return listWorkspaces().map(mapWorkspace);
  });
};
