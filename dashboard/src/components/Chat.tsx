import type { AgentInfo } from "../types";
import { ChatView } from "./ChatView";

interface Props {
  agent: AgentInfo;
  onBack: () => void;
  onTerminated: () => void;
}

/**
 * Agent chat: a thin wrapper over the shared ChatView (spec §7.1).
 * Behavior lives in ChatView so General Chat can reuse it in phase 7.
 */
export function Chat(props: Props) {
  return <ChatView {...props} />;
}
