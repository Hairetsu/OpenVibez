import { FormEvent, useState } from 'react';
import type { Session, Workspace } from '../../../preload/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

type SessionSidebarProps = {
  collapsed: boolean;
  onToggle: () => void;
  sessions: Session[];
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => Promise<void>;
  onCreateSession: () => Promise<void>;
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (workspaceId: string | null) => Promise<void>;
  onAddWorkspace: (path: string) => Promise<void>;
};

export const SessionSidebar = ({
  collapsed,
  onToggle,
  sessions,
  selectedSessionId,
  onSelectSession,
  onCreateSession,
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  onAddWorkspace
}: SessionSidebarProps) => {
  const [pathValue, setPathValue] = useState('');

  const onSubmitPath = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!pathValue.trim()) return;
    await onAddWorkspace(pathValue.trim());
    setPathValue('');
  };

  return (
    <aside
      className={cn(
        'flex h-full flex-col border-r border-border/50 bg-card/30 transition-[width] duration-200',
        collapsed ? 'w-12' : 'w-[240px]'
      )}
    >
      {collapsed ? (
        <div className="flex flex-1 flex-col items-center pt-3">
          <button
            type="button"
            onClick={onToggle}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between px-3 pb-1 pt-3">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Sessions</span>
            <div className="flex gap-0.5">
              <button
                type="button"
                onClick={() => void onCreateSession()}
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                title="New session"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              </button>
              <button
                type="button"
                onClick={onToggle}
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                title="Collapse sidebar"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 3L4 7l5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
            </div>
          </div>

          <div className="scroll-soft flex-1 overflow-auto px-1.5">
            {sessions.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">No sessions yet</p>
            ) : (
              <ul className="grid gap-px py-1">
                {sessions.map((session) => (
                  <li key={session.id}>
                    <button
                      type="button"
                      onClick={() => void onSelectSession(session.id)}
                      className={cn(
                        'w-full rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors',
                        selectedSessionId === session.id
                          ? 'bg-muted/70 text-foreground'
                          : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground'
                      )}
                    >
                      <span className="block truncate">{session.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="border-t border-border/40 px-3 py-2.5">
            <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Workspace
            </span>
            <div className="grid gap-1">
              <button
                type="button"
                onClick={() => void onSelectWorkspace(null)}
                className={cn(
                  'w-full rounded-md px-2 py-1 text-left text-xs transition-colors',
                  !selectedWorkspaceId
                    ? 'bg-muted/70 text-foreground'
                    : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground'
                )}
              >
                None
              </button>
              {workspaces.map((ws) => (
                <button
                  key={ws.id}
                  type="button"
                  onClick={() => void onSelectWorkspace(ws.id)}
                  className={cn(
                    'w-full rounded-md px-2 py-1 text-left text-xs transition-colors',
                    selectedWorkspaceId === ws.id
                      ? 'bg-muted/70 text-foreground'
                      : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground'
                  )}
                >
                  <span className="block truncate">{ws.name}</span>
                </button>
              ))}
            </div>
            <form className="mt-2 flex gap-1" onSubmit={onSubmitPath}>
              <Input
                value={pathValue}
                onChange={(e) => setPathValue(e.target.value)}
                placeholder="Add path..."
                className="h-7 text-xs"
              />
              <Button type="submit" size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-xs">
                +
              </Button>
            </form>
          </div>
        </>
      )}
    </aside>
  );
};
