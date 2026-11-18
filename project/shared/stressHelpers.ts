export const CHAT_SCROLL_THRESHOLD_PX = 72;

type ScrollMetrics = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

export function isNearScrollEnd(
  element: ScrollMetrics,
  threshold = CHAT_SCROLL_THRESHOLD_PX
) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

export function shouldShowNewMessages(current: boolean, nearBottom: boolean, isSending: boolean) {
  if (nearBottom) return false;
  return current || isSending;
}

export function normalizeGroupReplyLimit(value: unknown, participantCount: number) {
  if (!Number.isInteger(participantCount) || participantCount < 1) {
    return null;
  }

  const numeric = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || !Number.isInteger(numeric)) {
    return null;
  }

  if (numeric < 1 || numeric > participantCount) {
    return null;
  }

  return numeric;
}

export function participantSummary<T>(items: T[], visibleCount = 3) {
  const safeVisibleCount = Math.max(1, Math.floor(visibleCount));
  return {
    visible: items.slice(0, safeVisibleCount),
    remaining: Math.max(0, items.length - safeVisibleCount)
  };
}

export function sortPinnedByUpdated<T extends { pinnedAt?: string | null; updatedAt: string }>(items: T[]) {
  return [...items].sort((left, right) => {
    const leftPinned = left.pinnedAt ? Date.parse(left.pinnedAt) : 0;
    const rightPinned = right.pinnedAt ? Date.parse(right.pinnedAt) : 0;
    if (Boolean(left.pinnedAt) !== Boolean(right.pinnedAt)) return left.pinnedAt ? -1 : 1;
    if (leftPinned !== rightPinned) return rightPinned - leftPinned;
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
}
