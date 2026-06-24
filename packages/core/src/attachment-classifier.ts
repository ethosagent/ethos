import type { Attachment } from '@ethosagent/types';

export type AttachmentClass = 'native' | 'text' | 'extract' | 'unsupported';

// MIME types that go through the existing vision/content-block path (Class A)
const NATIVE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);
const PDF_NATIVE_MAX_BYTES = 32 * 1024 * 1024;

// MIME types for text-native files (Class B-text) - decode UTF-8 and inline
const TEXT_MIMES_PREFIX = 'text/';
const TEXT_MIMES_EXACT = new Set([
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/javascript',
  'application/typescript',
  'application/x-sh',
  'application/x-python',
]);

// File extensions that are text even if MIME type doesn't match
const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.json',
  '.jsonl',
  '.ndjson',
  '.xml',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.less',
  '.sass',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.kts',
  '.scala',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cc',
  '.hh',
  '.cxx',
  '.cs',
  '.swift',
  '.m',
  '.mm',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.bat',
  '.cmd',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.properties',
  '.sql',
  '.graphql',
  '.gql',
  '.r',
  '.R',
  '.jl',
  '.lua',
  '.pl',
  '.pm',
  '.php',
  '.hs',
  '.erl',
  '.ex',
  '.exs',
  '.clj',
  '.cljs',
  '.tf',
  '.hcl',
  '.dockerfile',
  '.makefile',
  '.env',
  '.gitignore',
  '.editorconfig',
  '.svg',
  '.tex',
  '.bib',
  '.rst',
  '.adoc',
  '.org',
  '.proto',
  '.thrift',
  '.avsc',
  '.log',
  '.diff',
  '.patch',
]);

// MIME types for extractable documents (Class B-extract) -- stubbed for PR2
const EXTRACT_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // .xls
  'application/vnd.ms-powerpoint', // .ppt
  'application/msword', // .doc
]);
const EXTRACT_EXTENSIONS = new Set(['.docx', '.pptx', '.xlsx', '.xls', '.ppt', '.doc', '.ipynb']);

function extensionOf(filename: string | undefined): string {
  if (!filename) return '';
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
}

export function classifyAttachment(att: Attachment): AttachmentClass {
  const mime = att.mimeType.toLowerCase();
  const ext = extensionOf(att.filename);

  if (NATIVE_MIMES.has(mime)) {
    if (mime === 'application/pdf' && att.sizeBytes && att.sizeBytes > PDF_NATIVE_MAX_BYTES) {
      return 'extract';
    }
    return 'native';
  }

  if (
    mime.startsWith(TEXT_MIMES_PREFIX) ||
    TEXT_MIMES_EXACT.has(mime) ||
    TEXT_EXTENSIONS.has(ext)
  ) {
    return 'text';
  }

  if (EXTRACT_MIMES.has(mime) || EXTRACT_EXTENSIONS.has(ext)) {
    return 'extract';
  }
  return 'unsupported';
}

export const SUPPORTED_TYPES_LABEL =
  'images (PNG, JPEG, GIF, WebP), PDF, text/code files, .docx, .pptx, .xlsx';

export function unsupportedTypeError(mimeType: string, filename?: string): string {
  const label = filename ? `"${filename}" (${mimeType})` : `"${mimeType}"`;
  return `${label} files aren't supported yet -- supported: ${SUPPORTED_TYPES_LABEL}`;
}
