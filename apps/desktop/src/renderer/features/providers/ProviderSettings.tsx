import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { ModelProfile, Provider, ProviderSubscriptionLoginState } from '../../../preload/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type ProviderSettingsProps = {
  providers: Provider[];
  onCreateProvider: (input: { displayName: string; authKind: Provider['authKind']; type?: Provider['type'] }) => Promise<void>;
  onSaveSecret: (providerId: string, secret: string) => Promise<{ ok: boolean }>;
  onTestProvider: (providerId: string) => Promise<{ ok: boolean; status?: number; reason?: string; models?: ModelProfile[] }>;
  onOpenExternal: (url: string) => Promise<void>;
  onStartSubscriptionLogin: (providerId: string) => Promise<ProviderSubscriptionLoginState>;
  onGetSubscriptionLoginState: () => Promise<ProviderSubscriptionLoginState>;
};

const CHATGPT_SUBSCRIPTION_URL = 'https://chatgpt.com';
const OPENAI_API_BILLING_URL = 'https://platform.openai.com/settings/organization/billing/overview';
const DEFAULT_OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';

const formatSuccessMessage = (models?: ModelProfile[]): string => {
  const count = models?.length ?? 0;
  return count > 0 ? `Connection OK (${count} models synced)` : 'Connection OK';
};

export const ProviderSettings = ({
  providers,
  onCreateProvider,
  onSaveSecret,
  onTestProvider,
  onOpenExternal,
  onStartSubscriptionLogin,
  onGetSubscriptionLoginState
}: ProviderSettingsProps) => {
  const [activeProviderId, setActiveProviderId] = useState<string>(providers[0]?.id ?? '');
  const [apiKey, setApiKey] = useState('');
  const [localEndpoint, setLocalEndpoint] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [newProviderName, setNewProviderName] = useState('OpenAI Primary');
  const [newProviderType, setNewProviderType] = useState<Provider['type']>('openai');
  const [newAuthKind, setNewAuthKind] = useState<Provider['authKind']>('api_key');
  const [subscriptionState, setSubscriptionState] = useState<ProviderSubscriptionLoginState | null>(null);

  useEffect(() => {
    if (!providers.length) {
      setActiveProviderId('');
      return;
    }

    const exists = providers.some((provider) => provider.id === activeProviderId);
    if (!exists) {
      setActiveProviderId(providers[0].id);
    }
  }, [activeProviderId, providers]);

  useEffect(() => {
    if (newProviderType === 'local') {
      if (newAuthKind !== 'api_key') {
        setNewAuthKind('api_key');
      }
      if (newProviderName === 'OpenAI Primary') {
        setNewProviderName('Local Ollama');
      }
      return;
    }

    if (newProviderType === 'openai' && newProviderName === 'Local Ollama') {
      setNewProviderName('OpenAI Primary');
    }
  }, [newAuthKind, newProviderName, newProviderType]);

  const activeProvider = useMemo(
    () => providers.find((provider) => provider.id === activeProviderId) ?? null,
    [activeProviderId, providers]
  );

  const onCreate = async () => {
    if (!newProviderName.trim()) return;
    await onCreateProvider({
      type: newProviderType,
      displayName: newProviderName.trim(),
      authKind: newProviderType === 'local' ? 'api_key' : newAuthKind
    });
    setStatus(`Created "${newProviderName.trim()}"`);
  };

  const onSubmitApiKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeProviderId || !apiKey.trim()) return;

    await onSaveSecret(activeProviderId, apiKey.trim());
    const result = await onTestProvider(activeProviderId);
    setStatus(result.ok
      ? formatSuccessMessage(result.models)
      : `Failed (${result.status ?? 'n/a'})${result.reason ? `: ${result.reason}` : ''}`
    );
  };

  const onSubmitLocalEndpoint = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeProviderId) return;

    await onSaveSecret(activeProviderId, localEndpoint.trim());

    const result = await onTestProvider(activeProviderId);
    setStatus(result.ok
      ? formatSuccessMessage(result.models)
      : `Failed (${result.status ?? 'n/a'})${result.reason ? `: ${result.reason}` : ''}`
    );
  };

  const onCheckSupport = async () => {
    if (!activeProviderId) return;
    const result = await onTestProvider(activeProviderId);
    setStatus(result.ok
      ? formatSuccessMessage(result.models)
      : `Failed (${result.status ?? 'n/a'})${result.reason ? `: ${result.reason}` : ''}`
    );
  };

  const onConnectChatGPT = async () => {
    if (!activeProviderId) return;
    const nextState = await onStartSubscriptionLogin(activeProviderId);
    setSubscriptionState(nextState);

    if (nextState.status === 'success') {
      const result = await onTestProvider(activeProviderId);
      setStatus(result.ok ? formatSuccessMessage(result.models) : `Failed (${result.status ?? 'n/a'})`);
      return;
    }

    if (nextState.verificationUri) await onOpenExternal(nextState.verificationUri);
    if (nextState.userCode) setStatus(`Enter code ${nextState.userCode} in the browser, then click Check Support.`);
  };

  const onRefreshLoginState = async () => {
    const next = await onGetSubscriptionLoginState();
    setSubscriptionState(next);

    if (next.status === 'success' && activeProviderId) {
      const result = await onTestProvider(activeProviderId);
      setStatus(result.ok ? formatSuccessMessage(result.models) : `Failed (${result.status ?? 'n/a'})`);
      return;
    }
    if (next.message) setStatus(next.message);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Providers</CardTitle>
        <CardDescription>Link API keys or ChatGPT subscription to sync models.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <Label className="text-xs">New provider</Label>
          <div className="grid gap-2 sm:grid-cols-[1fr_140px_160px_auto]">
            <Input value={newProviderName} onChange={(e) => setNewProviderName(e.target.value)} placeholder="Label" />
            <Select value={newProviderType} onValueChange={(v) => setNewProviderType(v as Provider['type'])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">OpenAI</SelectItem>
                <SelectItem value="local">Local (Ollama)</SelectItem>
              </SelectContent>
            </Select>
            <Select value={newAuthKind} onValueChange={(v) => setNewAuthKind(v as Provider['authKind'])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="api_key">API Key</SelectItem>
                {newProviderType !== 'local' && <SelectItem value="oauth_subscription">Subscription</SelectItem>}
              </SelectContent>
            </Select>
            <Button variant="outline" type="button" onClick={() => void onCreate()}>Add</Button>
          </div>
        </div>

        <div className="grid gap-2">
          <Label className="text-xs">Active provider</Label>
          <Select
            value={activeProviderId || '__none__'}
            onValueChange={(v) => { setActiveProviderId(v === '__none__' ? '' : v); setStatus(null); }}
          >
            <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
            <SelectContent>
              {providers.length === 0 && <SelectItem value="__none__">No providers</SelectItem>}
              {providers.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.displayName} [{p.type === 'local' ? 'Local' : p.authKind === 'api_key' ? 'Key' : 'Sub'}]
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {activeProvider?.type === 'local' ? (
          <form onSubmit={onSubmitLocalEndpoint} className="grid gap-2">
            <Label className="text-xs">Ollama endpoint (optional)</Label>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <Input
                autoComplete="off"
                value={localEndpoint}
                onChange={(e) => setLocalEndpoint(e.target.value)}
                placeholder={DEFAULT_OLLAMA_ENDPOINT}
              />
              <Button type="submit">{localEndpoint.trim() ? 'Save + Test' : 'Test Default'}</Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" type="button" onClick={() => void onCheckSupport()}>Refresh Models</Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Leave blank to use {DEFAULT_OLLAMA_ENDPOINT}.
            </p>
          </form>
        ) : activeProvider?.authKind === 'api_key' ? (
          <form onSubmit={onSubmitApiKey} className="grid gap-2">
            <Label className="text-xs">API key</Label>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." />
              <Button type="submit">Save + Test</Button>
            </div>
          </form>
        ) : (
          <div className="grid gap-3 rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3">
            <p className="text-xs text-muted-foreground">Use your ChatGPT subscription via Codex device login.</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" type="button" onClick={() => void onConnectChatGPT()}>Connect ChatGPT</Button>
              <Button size="sm" variant="outline" type="button" onClick={() => void onRefreshLoginState()}>Refresh</Button>
              <Button size="sm" variant="outline" type="button" onClick={() => void onCheckSupport()}>Check</Button>
            </div>
            {subscriptionState?.verificationUri && (
              <div className="text-xs">
                <span className="font-medium text-muted-foreground">URL: </span>
                <span className="break-all text-foreground/70">{subscriptionState.verificationUri}</span>
              </div>
            )}
            {subscriptionState?.userCode && (
              <div className="text-xs">
                <span className="font-medium text-muted-foreground">Code: </span>
                <span>{subscriptionState.userCode}</span>
              </div>
            )}
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" type="button" onClick={() => void onOpenExternal(CHATGPT_SUBSCRIPTION_URL)}>Open ChatGPT</Button>
              <Button size="sm" variant="ghost" type="button" onClick={() => void onOpenExternal(OPENAI_API_BILLING_URL)}>API Billing</Button>
            </div>
          </div>
        )}

        {status && <Badge variant="outline" className="w-fit">{status}</Badge>}
      </CardContent>
    </Card>
  );
};
