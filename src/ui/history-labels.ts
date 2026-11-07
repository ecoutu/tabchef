// Plain words for the codes History shows (#40, the project subset): a recently-closed entry's reason and a why-log
// entry's action. Codes without a label here are shown as they are.
const REASONS: Record<string, string> = { 'project-closed': 'closed with its project' };
const ACTIONS: Record<string, string> = { 'project-leave': 'removed from its project' };

export const reasonLabel = (reason: string): string => REASONS[reason] ?? reason;
export const actionLabel = (action: string): string => ACTIONS[action] ?? action;
