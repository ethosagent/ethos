// Classify IMAP/SMTP failures into actionable CHANNEL_CONFIG errors that name
// the platform, the cause, and the exact user fix. Anything unrecognized
// returns null — the caller keeps its existing error path.

import { channelConfigError, type EthosError } from '@ethosagent/types';

const PLATFORM = 'Email';

/** True when the error is a permanent credential rejection (as opposed to a
 *  transient network blip). Used to stop the poll loop instead of retrying a
 *  login the server will never accept. */
export function isAuthFailure(err: unknown): boolean {
  if (typeof err === 'object' && err !== null) {
    const e = err as { authenticationFailed?: unknown; responseText?: unknown };
    if (e.authenticationFailed === true) return true;
    if (
      typeof e.responseText === 'string' &&
      /LOGIN failed|AUTHENTICATIONFAILED/i.test(e.responseText)
    ) {
      return true;
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return /LOGIN failed|AUTHENTICATIONFAILED|Invalid credentials|Authentication failed/i.test(
    message,
  );
}

export function classifyChannelError(err: unknown): EthosError | null {
  if (isAuthFailure(err)) {
    return channelConfigError(
      PLATFORM,
      'the IMAP server rejected the login credentials.',
      'Check the email user/password in ~/.ethos/config.yaml. For Gmail/iCloud/Outlook, generate an app password (regular account passwords are refused when 2FA is on), then restart the gateway.',
    );
  }
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code: unknown }).code)
      : '';
  const message = err instanceof Error ? err.message : String(err);
  if (code === 'ENOTFOUND' || /ENOTFOUND/.test(message)) {
    return channelConfigError(
      PLATFORM,
      'the configured mail host could not be resolved (ENOTFOUND) — the hostname is likely wrong.',
      'Fix the IMAP/SMTP host in ~/.ethos/config.yaml (e.g. imap.gmail.com / smtp.gmail.com), then restart the gateway.',
    );
  }
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(message)) {
    return channelConfigError(
      PLATFORM,
      'the mail server refused the connection (ECONNREFUSED) — host or port is likely wrong.',
      'Check the IMAP/SMTP host and port in ~/.ethos/config.yaml (IMAP is usually 993, SMTP 587 or 465), then restart the gateway.',
    );
  }
  return null;
}
