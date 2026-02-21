import { registerChatHandlers } from './chat';
import { registerProviderHandlers } from './provider';
import { registerSettingsHandlers } from './settings';
import { registerSystemHandlers } from './system';
import { registerWorkspaceHandlers } from './workspace';

export const registerIpcHandlers = (): void => {
  registerProviderHandlers();
  registerChatHandlers();
  registerWorkspaceHandlers();
  registerSettingsHandlers();
  registerSystemHandlers();
};
