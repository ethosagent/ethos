import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { Tool, ToolResult } from '@ethosagent/types';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function buildTextHtml(ext: string, text: string, title?: string): string {
  void ext; // reserved for future syntax-highlighting per extension
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const displayTitle = title ?? '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12.5px; background: #111; color: #d4d4d4; padding: 12px; }
    h4 { font-size: 11px; font-weight: 600; color: #888; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
    pre { white-space: pre-wrap; word-break: break-word; line-height: 1.55; }
  </style></head><body>${displayTitle ? `<h4>${displayTitle.replace(/</g, '&lt;')}</h4>` : ''}<pre>${escaped}</pre></body></html>`;
}

interface SendImageArgs {
  src: string;
  alt?: string;
  title?: string;
}

interface SendHtmlArgs {
  html: string;
  title?: string;
  height?: number;
}

const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export const renderImageTool: Tool<SendImageArgs> = {
  name: 'render_image',
  description:
    'Display an image in the chat UI. Accepts a URL (https://...), a base64 data URI (data:image/...;base64,...), an absolute file path (/tmp/image.png), or a file:// URI (file:///tmp/image.png). The image renders inline in the conversation.',
  toolset: 'ui',
  alwaysInclude: true,
  maxResultChars: 500,
  capabilities: {},
  schema: {
    type: 'object',
    properties: {
      src: {
        type: 'string',
        description:
          'Image source: URL (https://...), base64 data URI (data:image/...;base64,...), absolute file path (/tmp/image.png), or file:// URI (file:///tmp/image.png). PNG, JPEG, SVG, WebP, GIF supported.',
      },
      alt: { type: 'string', description: 'Alt text for accessibility' },
      title: { type: 'string', description: 'Optional caption shown below the image' },
    },
    required: ['src'],
  },
  async execute(args): Promise<ToolResult> {
    let { src } = args;
    const { alt, title } = args;
    if (!src || typeof src !== 'string') {
      return { ok: false, code: 'input_invalid', error: 'src is required', field: 'src' };
    }
    const isUrl = src.startsWith('http://') || src.startsWith('https://');
    const isDataUri = src.startsWith('data:image/');
    const isFilePath = src.startsWith('/');
    const isFileUri = src.startsWith('file://');
    if (!isUrl && !isDataUri && !isFilePath && !isFileUri) {
      return {
        ok: false,
        code: 'input_invalid',
        error:
          'src must be a URL (https://...), base64 data URI (data:image/...;base64,...), absolute file path (/path/to/image), or file:// URI',
        field: 'src',
      };
    }
    if (isFilePath || isFileUri) {
      const filePath = isFileUri ? src.replace(/^file:\/\//, '') : src;
      try {
        const buf = await readFile(filePath);
        const mime = EXT_TO_MIME[extname(filePath).toLowerCase()] ?? 'image/png';
        src = `data:${mime};base64,${buf.toString('base64')}`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, code: 'execution_failed', error: `Could not read file: ${message}` };
      }
    }
    return {
      ok: true,
      value: title ? `Image: ${title}` : 'Image rendered.',
      structured: {
        _uiType: 'image' as const,
        content: src,
        metadata: { alt, title },
      },
    };
  },
};

export const renderHtmlTool: Tool<SendHtmlArgs> = {
  name: 'render_html',
  description:
    'Render a self-contained HTML document inline in the chat UI inside a sandboxed iframe. The HTML must be a complete, self-contained document (inline CSS and JS, no external dependencies that require same-origin access). Use for charts, tables, interactive demos, formatted reports.',
  toolset: 'ui',
  alwaysInclude: true,
  maxResultChars: 500,
  capabilities: {},
  schema: {
    type: 'object',
    properties: {
      html: {
        type: 'string',
        description: 'Complete self-contained HTML document string',
      },
      title: { type: 'string', description: 'Optional title shown above the frame' },
      height: {
        type: 'number',
        description: 'Initial iframe height in px (default 300, auto-adjusts via postMessage)',
      },
    },
    required: ['html'],
  },
  async execute(args): Promise<ToolResult> {
    const { html, title, height } = args;
    if (!html || typeof html !== 'string') {
      return { ok: false, code: 'input_invalid', error: 'html is required', field: 'html' };
    }
    return {
      ok: true,
      value: title ? `HTML: ${title}` : 'HTML rendered.',
      structured: {
        _uiType: 'html' as const,
        content: html,
        metadata: { title, height },
      },
    };
  },
};

interface SendFileArgs {
  src: string;
  title?: string;
}

export const renderFileTool: Tool<SendFileArgs> = {
  name: 'render_file',
  description:
    'Render a local file inline in the chat UI. Accepts absolute paths (/tmp/file.pdf) or file:// URIs. Images render as inline images; PDFs render in an embedded viewer; text/code/JSON/CSV/Markdown render as a formatted code block.',
  toolset: 'ui',
  alwaysInclude: true,
  maxResultChars: 500,
  capabilities: {},
  schema: {
    type: 'object',
    properties: {
      src: { type: 'string', description: 'Absolute file path or file:// URI' },
      title: { type: 'string', description: 'Optional label shown above the rendered content' },
    },
    required: ['src'],
  },
  async execute(args): Promise<ToolResult> {
    let { src } = args;
    const { title } = args;
    if (!src || typeof src !== 'string') {
      return { ok: false, code: 'input_invalid', error: 'src is required', field: 'src' };
    }

    // normalise file:// → absolute path
    if (src.startsWith('file://')) src = src.replace(/^file:\/\//, '');
    if (!src.startsWith('/')) {
      return {
        ok: false,
        code: 'input_invalid',
        error: 'src must be an absolute path or file:// URI',
        field: 'src',
      };
    }

    const ext = extname(src).toLowerCase();

    try {
      const buf = await readFile(src);

      // --- image ---
      if (IMAGE_EXTS.has(ext)) {
        const mime = IMAGE_MIME[ext] ?? 'image/png';
        return {
          ok: true,
          value: title ? `Image: ${title}` : 'Image rendered.',
          structured: {
            _uiType: 'image' as const,
            content: `data:${mime};base64,${buf.toString('base64')}`,
            metadata: { title },
          },
        };
      }

      // --- pdf ---
      if (ext === '.pdf') {
        return {
          ok: true,
          value: title ? `PDF: ${title}` : 'PDF rendered.',
          structured: {
            _uiType: 'pdf' as const,
            content: `data:application/pdf;base64,${buf.toString('base64')}`,
            metadata: { title },
          },
        };
      }

      // --- text / code / data ---
      const text = buf.toString('utf8');
      const html = buildTextHtml(ext, text, title);
      return {
        ok: true,
        value: title ? `File: ${title}` : 'File rendered.',
        structured: {
          _uiType: 'html' as const,
          content: html,
          metadata: { title },
        },
      };
    } catch (err) {
      return {
        ok: false,
        code: 'execution_failed',
        error: `Could not read file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

export function buildUiTools(): Tool[] {
  return [renderImageTool as Tool, renderHtmlTool as Tool, renderFileTool as Tool];
}
