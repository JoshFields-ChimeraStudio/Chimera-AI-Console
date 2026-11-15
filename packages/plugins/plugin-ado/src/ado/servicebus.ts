/**
 * Live listener for ADO service hook events on an Azure Service Bus queue.
 *
 * The SDK keeps one outbound AMQP connection open and the broker delivers
 * messages over it as they arrive, so nothing polls and nothing is exposed
 * publicly. The SDK reconnects on its own after transient failures.
 */
import { ServiceBusClient, type ServiceBusReceivedMessage } from "@azure/service-bus";

export type MessageOutcome = "complete" | "abandon" | "deadletter";

export interface ListenerHandlers {
  /** Decide what happens to the message: done, try again later, or park it in the dead-letter queue. */
  onMessage(
    body: unknown,
    info: { messageId: string; deliveryCount: number },
  ): Promise<{ outcome: MessageOutcome; reason?: string; delayMs?: number }>;
  onError(error: unknown): void;
}

export interface EventListener {
  close(): Promise<void>;
}

/** Factory seam so tests can run without a broker. */
export type ListenerFactory = (connectionString: string, queueName: string, handlers: ListenerHandlers) => EventListener;

export const serviceBusListener: ListenerFactory = (connectionString, queueName, handlers) => {
  const client = new ServiceBusClient(connectionString);
  const receiver = client.createReceiver(queueName, { receiveMode: "peekLock" });

  const subscription = receiver.subscribe(
    {
      async processMessage(msg: ServiceBusReceivedMessage) {
        const { outcome, reason, delayMs } = await handlers.onMessage(msg.body, {
          messageId: String(msg.messageId ?? ""),
          deliveryCount: msg.deliveryCount ?? 0,
        });
        // Unhandled outcomes fall back to the lock expiring, which also redelivers.
        if (outcome === "complete") await receiver.completeMessage(msg);
        else if (outcome === "deadletter") await receiver.deadLetterMessage(msg, { deadLetterReason: reason ?? "unprocessable", deadLetterErrorDescription: reason ?? "unprocessable" });
        else {
          // Hold the message before handing it back, so an ADO outage does not burn
          // through the delivery count in seconds. With one message at a time this
          // also slows the whole listener down while ADO is unhappy, which is intended.
          // The SDK renews the message lock while this handler runs, so the wait cannot lose it.
          if (delayMs && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
          await receiver.abandonMessage(msg);
        }
      },
      async processError(args) {
        handlers.onError(args.error);
      },
    },
    // One at a time keeps ADO calls ordered and inside the shared rate limit.
    { autoCompleteMessages: false, maxConcurrentCalls: 1 },
  );

  return {
    async close() {
      await subscription.close().catch(() => {});
      await receiver.close().catch(() => {});
      await client.close().catch(() => {});
    },
  };
};
