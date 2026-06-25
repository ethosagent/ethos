export type UploadState = 'uploading' | 'ready' | 'error';

export interface AttachmentPreview {
  localId: string;
  state: UploadState;
  type: 'image' | 'file';
  mimeType: string;
  name: string;
  sizeBytes: number;
  data?: string;
  previewUrl?: string;
}

export interface MessageAttachment {
  localId: string;
  state: UploadState;
  type: 'image' | 'file';
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl?: string;
}

export function toMessageAttachment(p: AttachmentPreview): MessageAttachment {
  return {
    localId: p.localId,
    state: p.state,
    type: p.type,
    name: p.name,
    mimeType: p.mimeType,
    sizeBytes: p.sizeBytes,
    ...(p.previewUrl ? { previewUrl: p.previewUrl } : {}),
  };
}

export function placeholderPreview(file: File): AttachmentPreview {
  const isImage = file.type.startsWith('image/');
  return {
    localId: crypto.randomUUID(),
    state: 'uploading',
    type: isImage ? 'image' : 'file',
    mimeType: file.type || 'application/octet-stream',
    name: file.name,
    sizeBytes: file.size,
    ...(isImage ? { previewUrl: URL.createObjectURL(file) } : {}),
  };
}

export function readPreviewData(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      const base64 = typeof result === 'string' ? (result.split(',')[1] ?? '') : '';
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'));
    reader.readAsDataURL(file);
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}
