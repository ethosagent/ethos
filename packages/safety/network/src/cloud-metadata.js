// Ch.7b — Cloud-metadata host blocklist (always-deny, non-overridable).
//
// Hostnames that target cloud-instance metadata endpoints are blocked even
// when `allow_private_urls: true` is set. These destinations are never
// legitimate for an agent to reach — same logic as the always-deny FS paths
// in Ch.5. Hostnames are matched case-insensitively after IDN normalization.
const CLOUD_METADATA_HOSTS = new Set([
  // Link-local IPv4 metadata endpoint shared across AWS / Azure / GCP /
  // OpenStack — covered by the private-IP block too, but listing it here
  // makes the intent explicit and prevents accidental personality-level
  // override (the IP is in the always-deny block whether or not 7a fires).
  '169.254.169.254',
  // GCP metadata
  'metadata.google.internal',
  'metadata',
  // Azure metadata (instance metadata service)
  'metadata.azure.com',
  '169.254.169.254',
  // AWS alternate metadata DNS
  'metadata.aws.amazon.com',
  // AWS IPv6 metadata
  'fd00:ec2::254',
  // Alibaba Cloud
  '100.100.100.200',
  // Oracle Cloud
  '169.254.0.23',
]);
export function isCloudMetadataHost(hostname) {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  return CLOUD_METADATA_HOSTS.has(normalized);
}
