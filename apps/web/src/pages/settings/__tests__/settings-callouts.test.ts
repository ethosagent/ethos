import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Form } from 'antd';
import { type ComponentType, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { SETTINGS_INDEX } from '../lib/settings-index';
import type { SettingsPaneContext } from '../pane-context';
import { VoicePane, VoiceTelephonySections } from '../panes/voice';
import { configGetFixture } from './config-get-fixture';

// T11a — plan/phases/settings-navigation.md §7, §10. Two claims:
//
//   1. The five §7 keys carry `status: 'unread'` in `SETTINGS_INDEX`, AND the
//      pane actually renders the "Accepted, currently unread" callout for
//      each of them — not just the index entry, the pixel.
//   2. The two derived switches (`voiceEnabled`, `voiceEgressGate`) render the
//      literal word `derived` in the key line's position, and nothing else
//      leaks into that line.
//
// `voiceEnabled` and the satellite half of barge-in render unconditionally in
// `VoicePane` (no `config` needed — verified by reading the source: every use
// of `configData` outside the `config ? … : null` gate is optional-chained).
// The trunk and hardening fields (`voiceTrunkUsername/Password/Codec`,
// `voiceInboundPrewarm`, `voiceEgressGate`) render only inside
// `VoiceTelephonySections`, which is gated on a non-null `config: ConfigGetData`
// — a ~110-field oRPC-inferred type. Building one is mechanical but sizeable,
// so `VoiceTelephonySections` is rendered directly (exported from `voice.tsx`
// for exactly this, same precedent as `AdminPanelGate` in `security.tsx` for
// T16) rather than pulling `QueryClientProvider` + `MemoryRouter` + the outlet
// harness into the mix a second time for a section that needs none of them.
//
// `renderToStaticMarkup`, same technique as `settings-advanced-dims.test.ts`
// (T8) — `apps/web` has no jsdom and this change deliberately does not add
// one.

const UNREAD_FORM_NAMES = [
  'voiceBargeIn.satellite.silenceMs',
  'voiceTrunkUsername',
  'voiceTrunkPassword',
  'voiceTrunkCodec',
  'voiceInboundPrewarm',
] as const;

const UNREAD_TEXT = 'Accepted, currently unread';

describe('the five §7 keys carry status: "unread" in the index', () => {
  it.each(UNREAD_FORM_NAMES)('%s', (formName) => {
    const entry = SETTINGS_INDEX.find((e) => e.formName === formName);
    expect(entry, `no index entry for formName ${formName}`).toBeDefined();
    expect(entry?.status).toBe('unread');
  });

  it('is exactly five — no more, no fewer, matching §7', () => {
    expect(
      SETTINGS_INDEX.filter((e) => e.status === 'unread')
        .map((e) => e.formName)
        .sort(),
    ).toEqual([...UNREAD_FORM_NAMES].sort());
  });
});

// ---------------------------------------------------------------------------
// Part A — VoicePane, config-independent: `voiceEnabled` (call appearance)
// and the barge-in satellite/call comparison.
// ---------------------------------------------------------------------------

function noop() {}

/** Stands in for `SettingsShell` — see `settings-advanced-dims.test.ts`. */
function Harness() {
  const [form] = Form.useForm();
  const context: SettingsPaneContext = {
    form,
    config: undefined,
    personalities: [],
    personalitiesLoading: false,
    quickCommandRows: [],
    setQuickCommandRows: noop,
    channelToolsetRows: [],
    setChannelToolsetRows: noop,
    voiceTtsProviderRows: [],
    setVoiceTtsProviderRows: noop,
    voiceSttProviderRows: [],
    setVoiceSttProviderRows: noop,
    voiceRealtimeProviderRows: [],
    setVoiceRealtimeProviderRows: noop,
    retentionRows: [],
    setRetentionRows: noop,
    voiceBotRows: [],
    setVoiceBotRows: noop,
  };
  return createElement(
    Form,
    { form, layout: 'vertical', component: false },
    createElement(Outlet, { context }),
  );
}

function paneMarkup(pane: ComponentType): string {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        MemoryRouter,
        { initialEntries: ['/'] },
        createElement(
          Routes,
          null,
          createElement(
            Route,
            { element: createElement(Harness) },
            createElement(Route, { path: '/', element: createElement(pane) }),
          ),
        ),
      ),
    ),
  );
}

/** The smallest enclosing `<div>…</div>` around a text marker — same
 *  depth-balanced technique as `settings-advanced-dims.test.ts`'s `dimmedBlock`.
 *  For the raw (non-`SettingRow`) barge-in boxes. */
function enclosingDiv(html: string, marker: string): string {
  const idx = html.indexOf(marker);
  expect(idx, `marker not found in markup: ${marker}`).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<div', idx);
  let depth = 0;
  for (let i = start; i < html.length; i += 1) {
    if (html.startsWith('<div', i)) depth += 1;
    else if (html.startsWith('</div>', i)) {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 6);
    }
  }
  throw new Error(`unterminated div for marker: ${marker}`);
}

/** The smallest enclosing `<div class="settings-row">…</div>` around a
 *  `SettingRow`'s label text — the trailing `"` in the search string picks
 *  the row wrapper itself, not `settings-row-info` / `-key` / `-label` /
 *  `-help` / `-control`, which all share the `settings-row` prefix. */
function enclosingRow(html: string, label: string): string {
  const idx = html.indexOf(`>${label}</div>`);
  expect(idx, `label not found in markup: ${label}`).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<div class="settings-row"', idx);
  expect(start, `no settings-row wrapper before label: ${label}`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = start; i < html.length; i += 1) {
    if (html.startsWith('<div', i)) depth += 1;
    else if (html.startsWith('</div>', i)) {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 6);
    }
  }
  throw new Error(`unterminated row for label: ${label}`);
}

describe('VoicePane — voiceEnabled renders "derived", not a key', () => {
  const html = paneMarkup(VoicePane);

  it('the key line is the literal word "derived"', () => {
    expect(html).toContain('>Voice enabled</div><div class="settings-row-key">derived</div>');
  });

  it('no plausible fake key leaks into that line', () => {
    const row = enclosingRow(html, 'Voice enabled');
    expect(row).not.toContain('voiceProvider');
    expect(row).not.toContain('voiceTtsProvider');
  });
});

describe('VoicePane — barge-in: satellite Silence is unread, call Silence is not', () => {
  const html = paneMarkup(VoicePane);

  it('the satellite row carries the callout', () => {
    expect(enclosingDiv(html, 'Wake satellite')).toContain(UNREAD_TEXT);
  });

  it('the phone-call row does not', () => {
    expect(enclosingDiv(html, 'Phone call')).not.toContain(UNREAD_TEXT);
  });
});

// ---------------------------------------------------------------------------
// Part B — VoiceTelephonySections directly: the trunk and hardening fields
// that need a non-null `config`.
// ---------------------------------------------------------------------------

function telephonyMarkup(): string {
  return renderToStaticMarkup(
    createElement(
      Form,
      // T1-ALLOW-MODAL-FORM: not a page-Save form — a bare host for the
      // `Form.Item`s `VoiceTelephonySections` renders on its own, mirroring
      // how `admin-panel-gate.test.ts` hosts `AdminPanelGate`. The trunk
      // sub-fields (username/password/codec) render only once the FORM's
      // `voiceTrunkProvider` is truthy (a `shouldUpdate` render-prop in the
      // pane) — independent of `config.voiceTrunkProvider`, which stays null.
      { component: false, initialValues: { voiceTrunkProvider: 'twilio' } },
      createElement(VoiceTelephonySections, {
        config: configGetFixture(),
        personalities: [],
        botRows: [],
        setBotRows: noop,
      }),
    ),
  );
}

describe('VoiceTelephonySections — the four unread trunk/hardening keys', () => {
  const html = telephonyMarkup();

  it.each(['SIP username', 'SIP password', 'Codec', 'Pre-warm on ring'])(
    '%s carries the callout',
    (label) => {
      expect(enclosingRow(html, label)).toContain(UNREAD_TEXT);
    },
  );

  it('appears exactly four times — no more, no fewer', () => {
    expect((html.match(new RegExp(UNREAD_TEXT, 'g')) ?? []).length).toBe(4);
  });
});

describe('VoiceTelephonySections — voiceEgressGate renders "derived", not a key', () => {
  const html = telephonyMarkup();

  it('the key line is the literal word "derived"', () => {
    expect(html).toContain(
      '>Restrict voice egress</div><div class="settings-row-key">derived</div>',
    );
  });

  it('no plausible fake key leaks into that line', () => {
    const row = enclosingRow(html, 'Restrict voice egress');
    expect(row).not.toContain('voice.trustedPlugins');
    expect(row).not.toContain('voiceTrustedPlugins');
  });
});
