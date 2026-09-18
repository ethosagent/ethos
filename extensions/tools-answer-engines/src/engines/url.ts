/** Hostname lower-cased with a leading `www.` stripped; null when `url` does not parse. */
export function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}
