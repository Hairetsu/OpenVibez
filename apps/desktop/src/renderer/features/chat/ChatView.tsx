import type { Message, MessageAccessMode, MessageStreamTrace, ModelProfile, Session, Workspace } from '../../../preload/types';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Composer } from './Composer';
import { MessageList } from './MessageList';

type ChatViewProps = {
  sessions: Session[];
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => Promise<void>;
  onCreateSession: () => Promise<void>;
  messages: Message[];
  onSend: (content: string) => Promise<void>;
  onCancel: () => Promise<void>;
  modelId: string;
  modelOptions: ModelProfile[];
  onModelChange: (modelId: string) => Promise<void>;
  accessMode: MessageAccessMode;
  onAccessModeChange: (mode: MessageAccessMode) => void;
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  onWorkspaceChange: (workspaceId: string | null) => Promise<void>;
  stream: {
    active: boolean;
    text: string;
    traces: MessageStreamTrace[];
    status: string | null;
  };
};

export const ChatView = ({
  modelId,
  modelOptions,
  onModelChange,
  accessMode,
  onAccessModeChange,
  messages,
  onSend,
  onCancel,
  stream
}: ChatViewProps) => {
  const hasSelectedModel = modelOptions.some((m) => m.modelId === modelId);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border/40 px-4 py-2">
        <Select value={modelId} onValueChange={(v) => void onModelChange(v)}>
          <SelectTrigger className="h-7 w-[180px] border-0 bg-transparent text-xs text-muted-foreground hover:text-foreground">
            <SelectValue placeholder="Model" />
          </SelectTrigger>
          <SelectContent>
            {modelOptions.map((m) => (
              <SelectItem key={m.modelId} value={m.modelId}>{m.label}</SelectItem>
            ))}
            {!hasSelectedModel && <SelectItem value={modelId}>{modelId}</SelectItem>}
          </SelectContent>
        </Select>

        <div className="h-4 w-px bg-border/40" />

        <Select value={accessMode} onValueChange={(v) => onAccessModeChange(v as MessageAccessMode)}>
          <SelectTrigger className="h-7 w-[120px] border-0 bg-transparent text-xs text-muted-foreground hover:text-foreground">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="scoped">Scoped</SelectItem>
            <SelectItem value="root">Root</SelectItem>
          </SelectContent>
        </Select>

        {stream.active && (
          <Badge variant="default" className="ml-auto animate-pulse text-[10px]">
            {stream.status ?? 'Running...'}
          </Badge>
        )}
      </div>

      <MessageList messages={messages} traces={stream.traces} liveText={stream.text} streaming={stream.active} />
      <Composer onSend={onSend} onCancel={onCancel} streaming={stream.active} />
    </div>
  );
};
