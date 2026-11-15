/**
 * Decoding of ADO service hook messages received from the Service Bus queue.
 * Messages are treated as "something changed" signals only: the worker always
 * re-reads the current state from ADO, because ADO can drop or reorder events.
 */

export type AdoEventKind =
  | { kind: "workitem"; eventType: string; workItemId: number }
  | { kind: "pullrequest"; eventType: string; pullRequestId: number; repositoryId: string | null }
  | { kind: "unknown"; eventType: string };

export interface AdoEvent {
  /** Service hook notification id, used to deduplicate redeliveries. */
  eventId: string;
  projectId: string | null;
  createdDate: string | null;
  target: AdoEventKind;
}

/**
 * Decode a Service Bus message body. With "bypass serializer" set on the ADO
 * subscription the body is raw JSON, which the SDK hands over as bytes or a
 * string; an already-parsed object is accepted too.
 */
export function decodeMessageBody(body: unknown): unknown {
  if (body instanceof Uint8Array) return decodeMessageText(Buffer.from(body).toString("utf8"));
  if (typeof body === "string") return decodeMessageText(body);
  if (body && typeof body === "object") return body;
  throw new Error("Message body is empty or of an unknown type");
}

/** Accept JSON as-is or base64-encoded. */
export function decodeMessageText(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
  if (decoded.startsWith("{")) return JSON.parse(decoded);
  throw new Error("Queue message is neither JSON nor base64-encoded JSON");
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

/** Fallback for "Minimal" payloads that may only carry the resource URL. */
function idFromUrl(url: unknown, pattern: RegExp): number | null {
  if (typeof url !== "string") return null;
  const m = url.match(pattern);
  return m ? num(m[1]) : null;
}

export function parseAdoEvent(payload: unknown): AdoEvent {
  if (!payload || typeof payload !== "object") throw new Error("Event payload is not an object");
  const p = payload as Record<string, any>;
  const eventType = String(p.eventType ?? "");
  if (!eventType) throw new Error("Event has no eventType");
  const r = (p.resource ?? {}) as Record<string, any>;

  let target: AdoEventKind = { kind: "unknown", eventType };
  if (eventType.startsWith("workitem.")) {
    // On workitem.updated, resource.id is the update id and workItemId is the item.
    const id =
      (eventType === "workitem.updated" ? num(r.workItemId) ?? num(r.revision?.id) : num(r.id) ?? num(r.workItemId)) ??
      idFromUrl(r.url, /\/workItems\/(\d+)/i);
    if (id) target = { kind: "workitem", eventType, workItemId: id };
  } else if (eventType.startsWith("git.pullrequest.") || eventType === "ms.vss-code.git-pullrequest-comment-event") {
    const pr = r.pullRequest ?? r;
    const id = num(pr.pullRequestId) ?? idFromUrl(pr.url, /\/pullRequests\/(\d+)/i);
    if (id) target = { kind: "pullrequest", eventType, pullRequestId: id, repositoryId: pr.repository?.id ?? null };
  }

  return {
    eventId: String(p.id ?? p.notificationId ?? ""),
    projectId: p.resourceContainers?.project?.id ?? null,
    createdDate: p.createdDate ?? null,
    target,
  };
}
