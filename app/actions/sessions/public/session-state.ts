import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentState,
  ConversationView,
  InboxState,
  LiveState,
} from "@earendil-works/pi-durable";

export type SessionState = {
  model: string;
  messages: {
    id: string;
    role: "user" | "assistant";
    text: string;
    reasoning?: string;
    error?: string;
  }[];
  busy: boolean;
  partial: string;
  reasoning: string;
  queued: number;
};

export type SessionSummary = {
  id: string;
  title: string;
  createdAt: number;
  busy: boolean;
  parentId: string | null;
};

export interface UserState {
  sessions: SessionSummary[];
  hasApiKey: boolean;
  keyStorageAvailable: boolean;
}

function text(content: string | readonly { type: string; text?: string }[] | undefined) {
  return typeof content === "string"
    ? content
    : (content
        ?.filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("") ?? "");
}

function reasoning(content: AssistantMessage["content"] | undefined) {
  return (content ?? [])
    .flatMap((block) => (block.type === "thinking" && !block.redacted ? [block.thinking] : []))
    .join("");
}

export function present(view: ConversationView, messages?: SessionState["messages"]): SessionState {
  const live = view.docs["pi.live"] as LiveState | undefined;
  const agent = view.docs["pi.agent"] as AgentState | undefined;
  messages ??= view.entries.flatMap((entry) =>
    (entry.model ?? []).flatMap((message, index) => {
      if (message.role !== "user" && message.role !== "assistant") return [];
      return [
        {
          id: `${entry.id}-${index}`,
          role: message.role,
          text: text(message.content),
          ...(message.role === "assistant" ? { reasoning: reasoning(message.content) } : {}),
          ...(message.role === "assistant" && message.errorMessage
            ? { error: message.errorMessage }
            : {}),
        },
      ];
    }),
  );
  const inbox = view.docs["pi.inbox"] as InboxState | undefined;
  return {
    model: agent?.model ? `${agent.model.provider}/${agent.model.modelId}` : "",
    messages,
    busy: !!live?.run,
    partial: text(live?.generation?.message?.content),
    reasoning: reasoning(live?.generation?.message?.content),
    queued: inbox?.items?.length ?? 0,
  };
}
