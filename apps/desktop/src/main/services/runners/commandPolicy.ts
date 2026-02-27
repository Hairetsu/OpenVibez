import path from 'node:path';
import type { WorkspaceRow } from '../db';

const MUTATING_PATTERNS: RegExp[] = [
  /(^|\s)(rm|mv|cp|chmod|chown|chgrp|touch|mkdir|rmdir|truncate|dd)(\s|$)/i,
  /(^|\s)(sed\s+-i|perl\s+-pi|awk\s+-i|ed\s)/i,
  /(^|\s)(git\s+(add|commit|reset|clean|rebase|merge|cherry-pick|push|tag|branch\s+-D))(\s|$)/i,
  /(^|\s)(npm|pnpm|yarn|bun)\s+(install|add|remove|update|up|upgrade|uninstall)(\s|$)/i,
  /(^|\s)(cargo\s+add|go\s+get\s+-u|pip\s+install|pip3\s+install)(\s|$)/i,
  /(^|\s)(tee\s+|cat\s+>)/i,
  /(>>?|<<)\s*[^|&]/
];

const HIGH_RISK_PATTERNS: RegExp[] = [
  /(^|\s)sudo(\s|$)/i,
  /rm\s+-rf\s+\/$/i,
  /rm\s+-rf\s+\/\s/i,
  /:\(\)\s*\{\s*:\|:\s*&\s*\};\s*:/,
  /mkfs\./i
];

const isSubPath = (parent: string, candidate: string): boolean => {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const isLikelyMutating = (command: string): boolean => {
  const normalized = command.trim();
  return MUTATING_PATTERNS.some((pattern) => pattern.test(normalized));
};

const isHighRiskCommand = (command: string): boolean => {
  return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(command));
};

export const enforceCommandPolicy = (input: {
  command: string;
  cwd: string;
  accessMode: 'scoped' | 'root';
  workspace?: WorkspaceRow;
}): void => {
  const command = input.command.trim();

  if (!command) {
    throw new Error('Refusing to run an empty shell command.');
  }

  if (isHighRiskCommand(command)) {
    throw new Error('Blocked high-risk command by policy.');
  }

  const workspace = input.workspace;

  if (workspace?.trust_level === 'untrusted') {
    throw new Error('Shell execution is disabled for untrusted workspaces.');
  }

  if (input.accessMode === 'scoped') {
    if (!workspace) {
      throw new Error('Scoped execution requires a selected workspace.');
    }

    const workspaceRoot = path.resolve(workspace.root_path);
    const resolvedCwd = path.resolve(input.cwd);
    if (!isSubPath(workspaceRoot, resolvedCwd)) {
      throw new Error(`Scoped execution blocked: cwd "${resolvedCwd}" is outside workspace root.`);
    }
  }

  const mutating = isLikelyMutating(command);
  if (workspace?.trust_level === 'read_only' && mutating) {
    throw new Error('Blocked mutating command in read-only workspace.');
  }

  if (input.accessMode === 'root' && workspace && workspace.trust_level !== 'trusted') {
    throw new Error('Root mode is allowed only for trusted workspaces.');
  }
};
