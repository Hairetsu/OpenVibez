import { logger } from '../util/logger';

export const startJobScheduler = (): void => {
  logger.info('Background scheduler initialized');
};
