/**
 * Template delete with undo (#54): the delete remembers where the template was so
 * '실행취소' puts it back at the same position (list order breaks auto-selection
 * ties). Pure list helpers; persistence stays with the caller.
 */
import type { MessageTemplate } from "../domain/types";

export interface RemovedTemplate {
  list: MessageTemplate[];
  removed: MessageTemplate;
  index: number;
}

/** The list without `id`, plus what was removed and from where; null if absent. */
export function removeTemplate(list: readonly MessageTemplate[], id: string): RemovedTemplate | null {
  const index = list.findIndex((t) => t.id === id);
  if (index < 0) return null;
  return { list: list.filter((_, i) => i !== index), removed: list[index], index };
}

/** Put `tpl` back at `index` (clamped). No-op copy when it is already present. */
export function restoreTemplateAt(list: readonly MessageTemplate[], tpl: MessageTemplate, index: number): MessageTemplate[] {
  if (list.some((t) => t.id === tpl.id)) return [...list];
  const at = Math.max(0, Math.min(list.length, index));
  return [...list.slice(0, at), tpl, ...list.slice(at)];
}
