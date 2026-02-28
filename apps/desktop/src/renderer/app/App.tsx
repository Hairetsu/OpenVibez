import { useCallback, useEffect, useState } from 'react';
import { ChatView } from '../features/chat/ChatView';
import { useChatStore } from '../features/chat/chat.store';
import { ProviderSettings } from '../features/providers/ProviderSettings';
import { SettingsView } from '../features/settings/SettingsView';
import { SessionSidebar } from '../features/sidebar/SessionSidebar';
import { TitleBar } from '@/components/TitleBar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

export const App = () => {
  const store = useChatStore();
  const [activePage, setActivePage] = useState<'chat' | 'settings'>('chat');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    void store.initialize();
  }, [store.initialize]);

  const onCreateSession = useCallback(
    () => store.createSession('New Session'),
    [store.createSession]
  );

  const visibleSessions = store.sessions.filter((session) => session.workspaceId === store.selectedWorkspaceId);
  const selectedSessionTraces = store.selectedSessionId ? (store.sessionTracesById[store.selectedSessionId] ?? []) : [];
  const selectedSessionTimeline = store.selectedSessionId ? (store.sessionTimelineById[store.selectedSessionId] ?? []) : [];
  const selectedSessionStatuses = store.selectedSessionId
    ? (store.sessionStatusesById[store.selectedSessionId] ?? [])
    : [];
  const visibleStream =
    store.selectedSessionId && store.streaming.active && store.streaming.sessionId === store.selectedSessionId
      ? store.streaming
      : {
          active: false,
          text: '',
          traces: selectedSessionTraces,
          timeline: selectedSessionTimeline,
          status: selectedSessionStatuses[selectedSessionStatuses.length - 1] ?? null,
          statusTrail: selectedSessionStatuses
        };
  const chatModelOptions = store.providers.flatMap((provider) =>
    (store.providerModelsById[provider.id] ?? []).map((model) => ({
      value: `${provider.id}::${model.modelId}`,
      modelId: model.modelId,
      providerId: provider.id,
      providerLabel: provider.displayName,
      label: model.label
    }))
  );
  const selectedModelValue = store.selectedProviderId
    ? `${store.selectedProviderId}::${store.selectedModelId}`
    : store.selectedModelId;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TitleBar>
        <div className="flex w-full items-center gap-3">
          <span className="text-[13px] font-semibold text-foreground/80">OpenVibez</span>
          <div className="h-4 w-px bg-border/60" />
          <nav className="flex gap-0.5">
            <button
              type="button"
              onClick={() => setActivePage('chat')}
              className={cn(
                'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                activePage === 'chat'
                  ? 'bg-muted/70 text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              Chat
            </button>
            <button
              type="button"
              onClick={() => setActivePage('settings')}
              className={cn(
                'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                activePage === 'settings'
                  ? 'bg-muted/70 text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              Settings
            </button>
          </nav>
        </div>
      </TitleBar>

      <div className="flex min-h-0 flex-1">
        <SessionSidebar
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((v) => !v)}
          sessions={visibleSessions}
          selectedSessionId={store.selectedSessionId}
          onSelectSession={store.selectSession}
          onCreateSession={onCreateSession}
          workspaces={store.workspaces}
          selectedWorkspaceId={store.selectedWorkspaceId}
          onSelectWorkspace={store.setSelectedWorkspaceId}
          onAddWorkspace={store.addWorkspace}
        />

        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {activePage === 'chat' ? (
            <ChatView
              sessions={visibleSessions}
              selectedSessionId={store.selectedSessionId}
              onSelectSession={store.selectSession}
              onCreateSession={onCreateSession}
              messages={store.messages}
              onSend={store.sendMessage}
              onCancel={store.cancelMessage}
              modelValue={selectedModelValue}
              modelOptions={chatModelOptions}
              onModelChange={async (value) => {
                const [providerId, ...modelParts] = value.split('::');
                const modelId = modelParts.join('::');
                if (!providerId || !modelId) {
                  return;
                }
                await store.selectChatModel({ providerId, modelId });
              }}
              accessMode={store.accessMode}
              onAccessModeChange={store.setAccessMode}
              workspaces={store.workspaces}
              selectedWorkspaceId={store.selectedWorkspaceId}
              onWorkspaceChange={store.setSelectedWorkspaceId}
              stream={visibleStream}
            />
          ) : (
            <div className="scroll-soft flex-1 overflow-auto">
              <div className="mx-auto grid max-w-4xl gap-4 p-4">
                <Tabs defaultValue="providers" className="grid gap-4">
                  <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border/50 pb-3">
                    <div className="grid gap-1">
                      <p className="display-font text-[11px] uppercase tracking-[0.18em] text-accent">
                        Settings
                      </p>
                      <h2 className="text-lg font-semibold text-foreground">
                        Connections and usage
                      </h2>
                    </div>
                    <TabsList className="h-9 rounded-full bg-muted/40">
                      <TabsTrigger value="providers" className="rounded-full px-4 text-xs">
                        Providers
                      </TabsTrigger>
                      <TabsTrigger value="analytics" className="rounded-full px-4 text-xs">
                        Analytics
                      </TabsTrigger>
                    </TabsList>
                  </div>

                  <TabsContent value="providers" className="mt-0">
                    <ProviderSettings
                      providers={store.providers}
                      activeProviderId={store.selectedProviderId}
                      modelProfiles={store.modelProfiles}
                      selectedModelId={store.selectedModelId}
                      onModelChange={store.setSelectedModelId}
                      onSelectProvider={store.setSelectedProviderId}
                      onCreateProvider={store.createProvider}
                      onSaveSecret={store.saveProviderSecret}
                      onTestProvider={store.testProvider}
                      onOpenExternal={store.openExternal}
                      onStartSubscriptionLogin={store.startSubscriptionLogin}
                      onGetSubscriptionLoginState={store.getSubscriptionLoginState}
                    />
                  </TabsContent>

                  <TabsContent value="analytics" className="mt-0">
                    <SettingsView usage={store.usageSummary} />
                  </TabsContent>
                </Tabs>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};
