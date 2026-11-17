// The in-app sink `ethos boot` hands the Gateway for the ambient channel
// digest. Split out of ./boot.ts, which re-exports it unchanged.

/**
 * Close the last wiring gap in the ambient channel digest
 * (plan/phases/ambient-group-monitoring.md R12, "the digest also lands in the
 * web notifications feed").
 *
 * `Gateway.runChannelDigest` posts each digest's in-app copy through
 * `GatewayConfig.channelDigestFeed`, and this is the only process that has one
 * to give it: `CreateWebApiResult.notifyChannelDigest`, which broadcasts the
 * existing `notification` SSE event to every connected session.
 *
 * It is a DIRECT sink and not a `NotificationRouter` wrapper any more. The
 * router was the wrong carrier twice over: `route()` returns `Promise<void>`,
 * so it cannot report whether the digest landed, and its default implementation
 * is a silent no-op when no adapter is registered for the key — which is always,
 * since web-api registers adapters only for CHAT session keys and a lane key
 * such as `telegram:bot-a:-100` is never one. Under `deliverTo: 'inApp'` the
 * gateway read that silence as delivery and marked the lane consumed.
 *
 * `ethos gateway` runs the digest with no in-process web API and `ethos serve`
 * runs a web API with no adapters and therefore no digest at all
 * (`channel-digest` is absent from serve's system-job roster). Under those two
 * commands there is no feed, so `deliverTo: 'inApp'` is refused at startup by
 * `channelDigestSystemTask` rather than discarding every digest.
 *
 * `omittedCount` is not dropped: the count is already inside the message as
 * `formatDigest`'s "showing N of M" footnote. The structured
 * `omittedCount`/`usedCount` fields on `notifyChannelDigest` stay unused rather
 * than being re-derived, which would print the same footnote twice.
 *
 * THE RETURN VALUE IS PASSED STRAIGHT THROUGH, and it is the reason this
 * adapter is not a one-line lambda at the call site. `notifyChannelDigest`
 * answers with the number of connected SSE sessions the digest was written to,
 * because it is an ephemeral multicast rather than a durable feed — nothing is
 * stored, so a digest broadcast with no browser tab open reaches nobody and
 * leaves no trace. Reporting that as delivery is what let a nightly digest be
 * summarised, marked consumed by the watermark, and discarded permanently.
 * Zero recipients has to arrive at the Gateway as zero.
 */
export function channelDigestFeed(
  notifyChannelDigest: (digest: { laneKey: string; summary: string }) => { recipients: number },
): (entry: { laneKey: string; text: string }) => { recipients: number } {
  return (entry) => notifyChannelDigest({ laneKey: entry.laneKey, summary: entry.text });
}
