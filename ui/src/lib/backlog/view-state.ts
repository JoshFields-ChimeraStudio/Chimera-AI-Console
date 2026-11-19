/**
 * Remembered Backlog view state (collapsed rows and groups, Show closed), per
 * company, in localStorage, the way the Tasks list keeps its view state.
 */

export interface BacklogViewState {
  collapsed: number[];
  noEpicCollapsed: boolean;
  showClosed: boolean;
}

export const DEFAULT_BACKLOG_VIEW_STATE: BacklogViewState = {
  collapsed: [],
  noEpicCollapsed: false,
  showClosed: false,
};

export function backlogViewStorageKey(companyId: string): string {
  return `paperclip:backlog-view:${companyId}`;
}

export function readBacklogViewState(companyId: string): BacklogViewState {
  try {
    const raw = window.localStorage.getItem(backlogViewStorageKey(companyId));
    if (!raw) return DEFAULT_BACKLOG_VIEW_STATE;
    const parsed = JSON.parse(raw) as Partial<Record<keyof BacklogViewState, unknown>>;
    return {
      collapsed: Array.isArray(parsed.collapsed)
        ? parsed.collapsed.filter((id): id is number => typeof id === "number" && Number.isInteger(id))
        : [],
      noEpicCollapsed: parsed.noEpicCollapsed === true,
      showClosed: parsed.showClosed === true,
    };
  } catch {
    return DEFAULT_BACKLOG_VIEW_STATE;
  }
}

export function writeBacklogViewState(companyId: string, state: BacklogViewState): void {
  try {
    window.localStorage.setItem(backlogViewStorageKey(companyId), JSON.stringify(state));
  } catch {
    // Storage full or blocked: the view still works for this session.
  }
}
