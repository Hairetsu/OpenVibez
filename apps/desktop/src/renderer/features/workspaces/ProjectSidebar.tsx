import { FormEvent, useState } from 'react';
import type { Workspace } from '../../../preload/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

type ProjectSidebarProps = {
  collapsed: boolean;
  onToggle: () => void;
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (workspaceId: string | null) => Promise<void>;
  onAddWorkspace: (path: string) => Promise<void>;
};

export const ProjectSidebar = ({
  collapsed,
  onToggle,
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  onAddWorkspace
}: ProjectSidebarProps) => {
  const [pathValue, setPathValue] = useState('');

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!pathValue.trim()) {
      return;
    }

    await onAddWorkspace(pathValue.trim());
    setPathValue('');
  };

  return (
    <aside
      className={cn(
        'relative z-10 border-b border-border/70 bg-background/45 p-3 backdrop-blur-xl lg:h-screen lg:border-b-0 lg:border-r',
        collapsed ? 'lg:w-[76px]' : 'lg:w-[300px]'
      )}
    >
      <Card className="grain-overlay h-full border-border/80 bg-card/70 p-3">
        <header className="mb-3 flex items-center justify-between gap-2">
          <div className={cn('min-w-0', collapsed && 'lg:hidden')}>
            <p className="display-font text-[11px] uppercase tracking-[0.18em] text-accent">Projects</p>
            <Badge variant="outline" className="mt-1">
              {workspaces.length} attached
            </Badge>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onToggle}>
            {collapsed ? '>' : '<'}
          </Button>
        </header>

        {!collapsed ? (
          <div className="grid h-[calc(100%-68px)] grid-rows-[1fr_auto] gap-3">
            <div className="scroll-soft overflow-auto pr-1">
              <ul className="grid gap-2">
                <li>
                  <Button
                    type="button"
                    variant={!selectedWorkspaceId ? 'secondary' : 'outline'}
                    className="h-auto w-full justify-start px-3 py-2 text-left"
                    onClick={() => {
                      void onSelectWorkspace(null);
                    }}
                  >
                    <span className="display-font text-xs uppercase tracking-[0.12em]">No Project Scope</span>
                  </Button>
                </li>
                {workspaces.map((workspace) => (
                  <li key={workspace.id}>
                    <Button
                      type="button"
                      variant={selectedWorkspaceId === workspace.id ? 'secondary' : 'outline'}
                      className="h-auto w-full justify-start px-3 py-2 text-left"
                      onClick={() => {
                        void onSelectWorkspace(workspace.id);
                      }}
                    >
                      <span className="grid w-full gap-1">
                        <strong className="display-font text-xs uppercase tracking-[0.12em] leading-none">{workspace.name}</strong>
                        <small className="text-[11px] text-muted-foreground">{workspace.rootPath}</small>
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            </div>

            <form className="grid gap-2" onSubmit={onSubmit}>
              <Input
                value={pathValue}
                onChange={(event) => setPathValue(event.target.value)}
                placeholder="/absolute/path/to/project"
              />
              <Button type="submit">Attach Project</Button>
            </form>
          </div>
        ) : (
          <div className="hidden h-full items-center justify-center lg:flex">
            <span className="display-font text-[11px] uppercase tracking-[0.22em] text-muted-foreground [writing-mode:vertical-lr]">
              OpenVibez
            </span>
          </div>
        )}
      </Card>
    </aside>
  );
};
