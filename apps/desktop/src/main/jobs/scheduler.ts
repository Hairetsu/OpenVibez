import { processActiveOpenAIBackgroundJobs } from './openaiBackgroundJobs';
import { logger } from '../util/logger';

const SCHEDULER_INTERVAL_MS = 4000;

let schedulerTimer: NodeJS.Timeout | null = null;
let schedulerTickInFlight = false;

const runSchedulerTick = async (): Promise<void> => {
  if (schedulerTickInFlight) {
    return;
  }

  schedulerTickInFlight = true;
  try {
    await processActiveOpenAIBackgroundJobs();
  } catch (error) {
    logger.warn('Background scheduler tick failed', error);
  } finally {
    schedulerTickInFlight = false;
  }
};

export const startJobScheduler = (): void => {
  if (schedulerTimer) {
    return;
  }

  logger.info('Background scheduler initialized');
  void runSchedulerTick();
  schedulerTimer = setInterval(() => {
    void runSchedulerTick();
  }, SCHEDULER_INTERVAL_MS);
};
