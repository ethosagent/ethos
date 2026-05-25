import keytar from 'keytar';

const SERVICE_NAME = 'ethos';

export async function setKeychainValue(key: string, value: string): Promise<void> {
  await keytar.setPassword(SERVICE_NAME, key, value);
}

export async function getKeychainValue(key: string): Promise<string | null> {
  return keytar.getPassword(SERVICE_NAME, key);
}

export async function deleteKeychainValue(key: string): Promise<void> {
  await keytar.deletePassword(SERVICE_NAME, key);
}
