/**
 * Decide whether an inbound `message` event may set a dashboard param.
 *
 * Dashboard panels render as `<iframe sandbox="allow-scripts">` (note: no
 * `allow-same-origin`), so their `postMessage` calls arrive with an opaque
 * origin that serializes to the literal string `"null"` — never
 * `location.origin`. A naive `origin === location.origin` gate would therefore
 * drop every legitimate panel emit.
 *
 * The load-bearing check is the source: the message must come from a direct
 * child frame of this window (a panel we rendered), not from `window.parent`
 * (an outer page embedding the whole app) or any unrelated window. That scopes
 * acceptance to our own panels while still allowing their opaque origin.
 *
 * Returns the `{ param, value }` to apply, or `null` to ignore the message.
 */
export function readTrustedParamMessage(
  e: Pick<MessageEvent, 'origin' | 'source' | 'data'>,
  self: Window,
): { param: string; value: string } | null {
  const originOk = e.origin === self.location.origin || e.origin === 'null';
  const source = e.source as Window | null;
  // A direct child frame's `parent` is this window. `parent` is one of the few
  // properties readable across an opaque/cross-origin boundary, so this holds
  // for sandboxed panels too.
  const fromChildFrame = source != null && source.parent === self;
  if (!originOk || !fromChildFrame) return null;

  const data = e.data as { type?: unknown; param?: unknown; value?: unknown } | null;
  if (
    data?.type === 'ethos:select' &&
    typeof data.param === 'string' &&
    typeof data.value === 'string'
  ) {
    return { param: data.param, value: data.value };
  }
  return null;
}
