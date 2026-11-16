import type { Topic } from './model';
// User-corrected source groups. These describe accounts, never every article's subject.
export const correctedSourceGroups: Readonly<Record<string, Topic>> = {
  'WX-001': 'opinion', 'WX-002': 'opinion', 'WX-003': 'cognition',
  'WX-006': 'opinion', 'WX-009': 'cognition', 'YT-001': 'cognition',
};
