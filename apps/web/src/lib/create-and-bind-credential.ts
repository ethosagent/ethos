// Create a named secret in the vault, then bind it to a tool settings key.
// Order is load-bearing (plan/phases/tool-credential-surface.md §13 case 20):
// vault first, binding second. A binding failure leaves the vault value — the
// value is reusable; rolling it back would delete what the operator just typed.

export interface CreateAndBindCredentialOpts {
  create: (input: { provider: string; name: string; value: string }) => Promise<unknown>;
  bind: (values: Record<string, Record<string, string>>) => Promise<unknown>;
  provider: string;
  name: string;
  value: string;
  /** Tool-settings storage key (e.g. `web_search`, `x_search`). */
  key: string;
  /** Which store the binding writes — caller chooses the `bind` impl to match. */
  scope: 'personality' | 'global';
  /** Extra fields on the binding row (e.g. `provider` for web_search). */
  bindingExtra?: Record<string, string>;
}

/**
 * Write vault value, then write the binding. Does not roll back the vault if
 * bind fails.
 */
export async function createAndBindCredential(opts: CreateAndBindCredentialOpts): Promise<void> {
  await opts.create({
    provider: opts.provider,
    name: opts.name,
    value: opts.value,
  });
  await opts.bind({
    [opts.key]: {
      ...(opts.bindingExtra ?? {}),
      secret: opts.name,
    },
  });
}
