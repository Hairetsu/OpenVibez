import { useCallback, useEffect, useState } from 'react';
import { ChatView } from '../features/chat/ChatView';
import { useChatStore } from '../features/chat/chat.store';
import { ProviderSettings } from '../features/providers/ProviderSettings';
import { SettingsView } from '../features/settings/SettingsView';
import { SessionSidebar } from '../features/sidebar/SessionSidebar';
import { TitleBar } from '@/components/TitleBar';
import { cn } from '@/lib/utils';

export const App = () => {
  const store = useChatStore();
  const [activePage, setActivePage] = useState<'chat' | 'settings'>('chat');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    void store.initialize();
  }, [store.initialize]);

  const onCreateSession = useCallback(
    () => store.createSession(`Session ${new Date().toLocaleTimeString()}`),
    [store.createSession]
  );

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
          sessions={store.sessions}
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
              sessions={store.sessions}
              selectedSessionId={store.selectedSessionId}
              onSelectSession={store.selectSession}
              onCreateSession={onCreateSession}
              messages={store.messages}
              onSend={store.sendMessage}
              onCancel={store.cancelMessage}
              modelId={store.selectedModelId}
              modelOptions={store.modelProfiles}
              onModelChange={store.setSelectedModelId}
              accessMode={store.accessMode}
              onAccessModeChange={store.setAccessMode}
              workspaces={store.workspaces}
              selectedWorkspaceId={store.selectedWorkspaceId}
              onWorkspaceChange={store.setSelectedWorkspaceId}
              stream={store.streaming}
            />
          ) : (
            <div className="scroll-soft flex-1 overflow-auto p-4">
              <div className="mx-auto grid max-w-2xl gap-4">
                <ProviderSettings
                  providers={store.providers}
                  onCreateProvider={store.createProvider}
                  onSaveSecret={store.saveProviderSecret}
                  onTestProvider={store.testProvider}
                  onOpenExternal={store.openExternal}
                  onStartSubscriptionLogin={store.startSubscriptionLogin}
                  onGetSubscriptionLoginState={store.getSubscriptionLoginState}
                />
                <SettingsView usage={store.usageSummary} />
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};
