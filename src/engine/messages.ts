/** Messages between the background worker and the dedupe banner content script. */
export type BannerShowMessage = {
  type: 'banner.show';
  payload:
    | { kind: 'duplicate'; existingTitle: string; groupTitle?: string; tabId: number; existingTabId: number }
    | { kind: 'undo'; entryId: string; text: string };
};
export type BannerChoice = 'switch' | 'keep' | 'always-switch-site';
export type BannerChoiceMessage = { type: 'banner.choice'; choice: BannerChoice; tabId: number; existingTabId: number };
export type BannerMessage = BannerShowMessage | BannerChoiceMessage;

export function isBannerChoiceMessage(m: unknown): m is BannerChoiceMessage {
  if (typeof m !== 'object' || m === null) return false;
  const x = m as Record<string, unknown>;
  return x.type === 'banner.choice' && typeof x.tabId === 'number' && typeof x.existingTabId === 'number'
    && (x.choice === 'switch' || x.choice === 'keep' || x.choice === 'always-switch-site');
}

/** Exact banner copy. */
export function bannerText(groupTitle: string | undefined): string {
  return `Already open in ${groupTitle || 'another tab'}.`;
}

/** The content script's reply to banner.show, sent after the banner is rendered. */
export type BannerAck = { ok: true };

/** Undo toast answer from the banner (no tabId: it refers to a recently-closed entry). */
export type UndoChoiceMessage = { type: 'banner.choice'; choice: 'undo'; entryId: string };
export function isUndoChoiceMessage(m: unknown): m is UndoChoiceMessage {
  if (typeof m !== 'object' || m === null) return false;
  const x = m as Record<string, unknown>;
  return x.type === 'banner.choice' && x.choice === 'undo' && typeof x.entryId === 'string';
}

/** Content script -> worker: the user typed into a form field on this page (best effort, once per page). */
export type FormEditedMessage = { type: 'tab.formEdited' };
export function isFormEditedMessage(m: unknown): m is FormEditedMessage {
  return typeof m === 'object' && m !== null && (m as Record<string, unknown>).type === 'tab.formEdited';
}

/** Undo toast copy. */
export function undoText(e: { title: string; url: string; reason: string }): string {
  return `Closed "${e.title || e.url}" (${e.reason}).`;
}

export const UNDO_NOTIFICATION_PREFIX = 'undo:';
