import { z } from 'zod';
import type { AttentionItem } from './attention-state';

// Browser-local opt-in for system notifications. Per-browser convenience only:
// localStorage, never PersonalityConfig / config.yaml / server.

export const ATTENTION_NOTIFY_KEY = 'ethos.attentionNotifications';

const PrefSchema = z.enum(['on', 'off']);
const PermissionSchema = z.enum(['granted', 'denied', 'default']);

export function getAttentionNotifyPref(): boolean {
  try {
    const parsed = PrefSchema.safeParse(localStorage.getItem(ATTENTION_NOTIFY_KEY));
    return parsed.success && parsed.data === 'on';
  } catch {
    // Blocked storage (private window): treat as off.
    return false;
  }
}

export function setAttentionNotifyPref(on: boolean): boolean {
  try {
    localStorage.setItem(ATTENTION_NOTIFY_KEY, on ? 'on' : 'off');
    return true;
  } catch {
    // Blocked storage: report failure so the caller can show it.
    return false;
  }
}

export type NotifySupport = 'unsupported' | 'granted' | 'denied' | 'default';

export function notificationSupport(): NotifySupport {
  if (typeof Notification === 'undefined') return 'unsupported';
  const parsed = PermissionSchema.safeParse(Notification.permission);
  return parsed.success ? parsed.data : 'unsupported';
}

/** Call only from a user gesture (the toggle's click handler). Stores 'on' only if granted. */
export async function enableAttentionNotifications(): Promise<NotifySupport> {
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    const parsed = PermissionSchema.safeParse(await Notification.requestPermission());
    if (!parsed.success) return 'unsupported';
    if (parsed.data === 'granted') setAttentionNotifyPref(true);
    return parsed.data;
  } catch {
    // requestPermission can throw on legacy/embedded browsers.
    return 'unsupported';
  }
}

export interface AttentionNotificationSpec {
  title: string;
  body: string;
  tag: string;
}

/** Body is built only from kind + detail (tool name / plugin label), never message or question text. */
export function buildAttentionNotification(item: AttentionItem): AttentionNotificationSpec {
  const body =
    item.kind === 'approval'
      ? `Approval needed: ${item.detail}`
      : item.kind === 'credential'
        ? `Credential needed: ${item.detail}`
        : 'Question waiting';
  // Equal tag: same-origin tabs raising the same item replace each other natively.
  return { title: 'Ethos needs you', body, tag: item.key };
}

export function showAttentionNotification(
  item: AttentionItem,
  onOpen: (item: AttentionItem) => void,
): void {
  if (!getAttentionNotifyPref() || notificationSupport() !== 'granted') return;
  const spec = buildAttentionNotification(item);
  try {
    const notification = new Notification(spec.title, { body: spec.body, tag: spec.tag });
    notification.onclick = () => {
      window.focus();
      onOpen(item);
      notification.close();
    };
  } catch {
    // Constructor throws on some mobile browsers (Notification needs a service worker); no signal.
  }
}
