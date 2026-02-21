import { summarizeUsage } from './db';

export const getUsageSummary = (days: number): { inputTokens: number; outputTokens: number; costMicrounits: number } => {
  const summary = summarizeUsage(days);
  return {
    inputTokens: summary.input_tokens,
    outputTokens: summary.output_tokens,
    costMicrounits: summary.cost_microunits
  };
};
