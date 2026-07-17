// Pure launch-close logic for the W2.5 three-way close, kept free of Ink/React
// imports so it can be unit-tested without a render harness (same reason the
// wizard reducer is tested in isolation).

export type LaunchChoice = 'gateway' | 'chat' | 'done';

export interface LaunchOption {
  id: LaunchChoice;
  label: string;
}

/** The three-way close options. The gateway option appears ONLY when a channel
 *  validated during setup — otherwise "clone → talking bot" isn't reachable and
 *  offering it would dead-end. */
export function launchOptions(hasValidatedChannel: boolean): LaunchOption[] {
  const options: LaunchOption[] = [];
  if (hasValidatedChannel) {
    options.push({ id: 'gateway', label: 'Start the Telegram bot now' });
  }
  options.push({ id: 'chat', label: 'Open chat instead' });
  options.push({ id: 'done', label: 'Done' });
  return options;
}
