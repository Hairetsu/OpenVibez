import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type SettingsViewProps = {
  usage: { inputTokens: number; outputTokens: number; costMicrounits: number } | null;
};

const formatCost = (microunits: number): string => `$${(microunits / 1_000_000).toFixed(4)}`;

export const SettingsView = ({ usage }: SettingsViewProps) => {
  return (
    <Card>
      <CardHeader>
        <CardTitle>30-Day Usage</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-md border border-border/50 bg-background/40 p-3">
          <span className="text-[11px] font-medium text-muted-foreground">Input Tokens</span>
          <strong className="mt-1 block text-lg">{usage?.inputTokens ?? 0}</strong>
        </div>
        <div className="rounded-md border border-border/50 bg-background/40 p-3">
          <span className="text-[11px] font-medium text-muted-foreground">Output Tokens</span>
          <strong className="mt-1 block text-lg">{usage?.outputTokens ?? 0}</strong>
        </div>
        <div className="rounded-md border border-border/50 bg-background/40 p-3">
          <span className="text-[11px] font-medium text-muted-foreground">Est. Cost</span>
          <strong className="mt-1 block text-lg">{formatCost(usage?.costMicrounits ?? 0)}</strong>
        </div>
      </CardContent>
    </Card>
  );
};
