/** Messages between the background worker and the dedupe banner content script. */
export type BannerShowMessage = {
  type: 'banner.show';
  payload: { kind: 'duplicate'; existingTitle: string; groupTitle?: string; tabId: number; existingTabId: number };
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
