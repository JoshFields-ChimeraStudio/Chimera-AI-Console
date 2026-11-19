import { useClassicTaskInterfaceEnabled } from "./useClassicTaskInterfaceEnabled";
import { useCoordinatorWorkspaceEnabled } from "./useCoordinatorWorkspaceEnabled";
import { useStreamlinedUiEnabled } from "./useStreamlinedUiEnabled";

/**
 * Which task detail presentation is active: the classic thread
 * (`IssueChatThread`) or the chat-style thread (`TaskChatThread`), plus the
 * streamlined/coordinator shell flags. Shared by the task page and by surfaces
 * that show a task's conversation elsewhere (the Backlog work item page), so
 * both pick the same thread component.
 */
export function useTaskDetailInterfaceMode(conversationMode = false) {
  const {
    enabled: classicTaskInterfacePreferenceEnabled,
    loaded: classicTaskInterfaceLoaded,
  } = useClassicTaskInterfaceEnabled();
  const { enabled: classicStreamlinedUiEnabled, loaded: streamlinedUiLoaded } =
    useStreamlinedUiEnabled();
  const { enabled: coordinatorWorkspaceEnabled, loaded: coordinatorLoaded } = useCoordinatorWorkspaceEnabled();
  const streamlinedUiEnabled = classicStreamlinedUiEnabled || coordinatorWorkspaceEnabled;
  const classicTaskInterfaceEnabled = classicTaskInterfacePreferenceEnabled && !conversationMode && !coordinatorWorkspaceEnabled;
  const taskChatShellEnabled = !classicTaskInterfaceEnabled;

  return {
    coordinatorWorkspaceEnabled,
    classicTaskInterfaceEnabled,
    taskChatShellEnabled,
    streamlinedTaskDetailEnabled: streamlinedUiEnabled && taskChatShellEnabled,
    streamlinedUiEnabled,
    loaded: classicTaskInterfaceLoaded && streamlinedUiLoaded && coordinatorLoaded,
  };
}
