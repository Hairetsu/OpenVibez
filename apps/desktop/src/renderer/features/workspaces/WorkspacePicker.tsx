import { FormEvent, useState } from 'react';
import type { Workspace } from '../../../preload/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

type WorkspacePickerProps = {
  workspaces: Workspace[];
  onAddWorkspace: (path: string) => Promise<void>;
};

export const WorkspacePicker = ({ workspaces, onAddWorkspace }: WorkspacePickerProps) => {
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
    <Card className="stagger-3 border-border/70 bg-card/70">
      <CardHeader>
        <CardTitle>Workspaces</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <form className="grid gap-2" onSubmit={onSubmit}>
          <Input value={pathValue} onChange={(event) => setPathValue(event.target.value)} placeholder="/absolute/path/to/workspace" />
          <Button type="submit" className="w-fit">
            Attach
          </Button>
        </form>
        <ul className="grid gap-2">
          {workspaces.map((workspace) => (
            <li key={workspace.id} className="rounded-md border border-border/80 bg-background/35 p-3">
              <strong className="display-font text-xs uppercase tracking-[0.12em] text-accent">{workspace.name}</strong>
              <p className="mt-1 text-xs text-muted-foreground">{workspace.rootPath}</p>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
};
