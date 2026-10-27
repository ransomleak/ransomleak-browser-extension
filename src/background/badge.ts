// Toolbar badge: the number of open assigned trainings (chrome.action needs no permission).
/** Overdue items present: amber (dark enough for the white badge text). */
export const BADGE_OVERDUE = '#B45309';
/** Open items, none overdue: the brand sage. */
export const BADGE_OPEN = '#047857';

export async function setTodoBadge(total: number, overdue: boolean): Promise<void> {
  const action = chrome.action;
  if (!action?.setBadgeText) return;
  const n = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  await action.setBadgeText({ text: n === 0 ? '' : n > 99 ? '99+' : String(n) });
  if (n > 0) await action.setBadgeBackgroundColor?.({ color: overdue ? BADGE_OVERDUE : BADGE_OPEN });
}

/** Signed out, paused or re-bound: no count. */
export async function clearBadge(): Promise<void> {
  try {
    await chrome.action?.setBadgeText?.({ text: '' });
  } catch {
    /* no action API (tests, very old browser) */
  }
}
