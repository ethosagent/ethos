// `ethos gateway start` — WhatsApp QR / pairing-code reporting, split out of
// gateway.ts (`buildGatewayAdapters` spreads it into `buildAdapters`' opts). The
// code is printed to the console AND pushed to the web API's pairing surface, so
// an operator can link a device from either place.

import { c } from './_shared';

export function whatsAppLinkHandlers() {
  return {
    onWhatsAppQr: (botId: string, qr: string | null) => {
      import('@ethosagent/web-api').then((m) => m.setWhatsAppQr(botId, qr)).catch(() => {});
    },
    onWhatsAppPairingCode: (botId: string, code: string | null) => {
      if (code !== null) {
        console.log(
          `\n  ${c.bold}WhatsApp pairing code for "${botId}": ${c.cyan}${code}${c.reset}\n` +
            `  ${c.dim}On that phone: WhatsApp → Linked Devices → Link with phone number instead → enter the code.${c.reset}\n`,
        );
      }
      import('@ethosagent/web-api')
        .then((m) => m.setWhatsAppPairingCode(botId, code))
        .catch(() => {});
    },
  };
}
