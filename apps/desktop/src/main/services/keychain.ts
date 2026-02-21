import { logger } from '../util/logger';

const FALLBACK_SECRETS = new Map<string, string>();
const SERVICE_NAME = 'OpenVibez';

const loadKeytar = async (): Promise<typeof import('keytar') | null> => {
  try {
    return await import('keytar');
  } catch (error) {
    logger.warn('keytar unavailable, using in-memory fallback only for current run', error);
    return null;
  }
};

export const setSecret = async (account: string, secret: string): Promise<void> => {
  const keytar = await loadKeytar();
  if (keytar) {
    await keytar.setPassword(SERVICE_NAME, account, secret);
    return;
  }

  FALLBACK_SECRETS.set(account, secret);
};

export const getSecret = async (account: string): Promise<string | null> => {
  const keytar = await loadKeytar();
  if (keytar) {
    return keytar.getPassword(SERVICE_NAME, account);
  }

  return FALLBACK_SECRETS.get(account) ?? null;
};

export const removeSecret = async (account: string): Promise<boolean> => {
  const keytar = await loadKeytar();
  if (keytar) {
    return keytar.deletePassword(SERVICE_NAME, account);
  }

  return FALLBACK_SECRETS.delete(account);
};
