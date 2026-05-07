import { describe, expect, it } from 'vitest';
import { isCloudMetadataHost } from '../cloud-metadata';

describe('isCloudMetadataHost', () => {
  it.each([
    ['169.254.169.254'],
    ['metadata.google.internal'],
    ['metadata'],
    ['metadata.azure.com'],
    ['metadata.aws.amazon.com'],
    ['fd00:ec2::254'],
    ['100.100.100.200'],
    ['169.254.0.23'],
  ])('flags %s', (host) => {
    expect(isCloudMetadataHost(host)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isCloudMetadataHost('METADATA.GOOGLE.INTERNAL')).toBe(true);
  });

  it('strips IPv6 brackets', () => {
    expect(isCloudMetadataHost('[fd00:ec2::254]')).toBe(true);
  });

  it('does not flag normal hosts', () => {
    expect(isCloudMetadataHost('example.com')).toBe(false);
    expect(isCloudMetadataHost('169.254.169.255')).toBe(false);
  });
});
