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

export function fileToPreview(file: File): Promise<AttachmentPreview> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        localId: crypto.randomUUID(),
        state: 'ready',
        type: file.type.startsWith('image/') ? 'image' : 'file',
        mimeType: file.type || 'application/octet-stream',
        name: file.name,
        sizeBytes: file.size,
        data: (reader.result as string).split(',')[1],
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
      });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
