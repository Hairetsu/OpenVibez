type SettingsViewProps = {
  usage: { inputTokens: number; outputTokens: number; costMicrounits: number } | null;
};

const formatCost = (microunits: number): string => `$${(microunits / 1_000_000).toFixed(4)}`;
const formatNumber = (value: number): string => new Intl.NumberFormat().format(value);

export const SettingsView = ({ usage }: SettingsViewProps) => {
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const totalTokens = inputTokens + outputTokens;
  const outputShare = totalTokens > 0 ? Math.round((outputTokens / totalTokens) * 100) : 0;

  return (
    <section className="grid gap-4">
      <div className="grid gap-1">
        <p className="display-font text-[11px] uppercase tracking-[0.18em] text-accent">
          Analytics
        </p>
        <h3 className="text-base font-semibold text-foreground">30-day usage</h3>
        <p className="text-xs text-muted-foreground">
          Local token and cost totals across your recent sessions.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <div className="border-b border-border/60 pb-3 md:border-b-0 md:border-r md:pb-0 md:pr-4">
          <span className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            Input Tokens
          </span>
          <strong className="mt-2 block text-2xl font-semibold">
            {formatNumber(inputTokens)}
          </strong>
        </div>
        <div className="border-b border-border/60 pb-3 md:border-b-0 md:border-r md:pb-0 md:pr-4">
          <span className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            Output Tokens
          </span>
          <strong className="mt-2 block text-2xl font-semibold">
            {formatNumber(outputTokens)}
          </strong>
        </div>
        <div>
          <span className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            Estimated Cost
          </span>
          <strong className="mt-2 block text-2xl font-semibold">
            {formatCost(usage?.costMicrounits ?? 0)}
          </strong>
        </div>
      </div>

      <div className="grid gap-3 border-t border-border/50 pt-4 md:grid-cols-2">
        <div className="grid gap-1">
          <span className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            Total Tokens
          </span>
          <span className="text-sm text-foreground">{formatNumber(totalTokens)}</span>
        </div>
        <div className="grid gap-1">
          <span className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            Output Share
          </span>
          <span className="text-sm text-foreground">{outputShare}%</span>
        </div>
      </div>
    </section>
  );
};
