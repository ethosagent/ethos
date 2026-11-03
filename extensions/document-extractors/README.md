# @ethosagent/document-extractors

## Purpose

Built-in text extractors for office and notebook documents: Word, Excel, PowerPoint, Jupyter notebooks and PDF. Each class turns raw bytes into an `ExtractedDocument` of plain text or Markdown. The registry, and the decision of when to call an extractor, belong to core and the tools that read attachments.

## Public surface

Single entry point, `src/index.ts` (the only `exports` key in `package.json` is `.`).

| Export | Kind | One line |
|---|---|---|
| `registerBuiltinExtractors` | function | Registers all five extractors on a `DocumentExtractorRegistry`. |
| `DocxExtractor` | class | `.docx` and `.doc` text through `mammoth`. |
| `XlsxExtractor` | class | `.xlsx` and `.xls` sheets through `xlsx`. |
| `PptxExtractor` | class | `.pptx` and `.ppt` slide text. |
| `IpynbExtractor` | class | Jupyter notebook cells and outputs as Markdown. |
| `PdfTextExtractor` | class | PDF text through a lazily imported `pdf-parse`. |

## Seam

Each class implements `DocumentExtractor` from `@ethosagent/types` (`packages/types/src/document-extractor.ts`), declaring its `mimeTypes` and a `maxInputBytes` cap; `registerBuiltinExtractors` takes the `DocumentExtractorRegistry` from the same file. Archcheck layer: `extensions`. Limitation: only the notebook extractor has a test, so the input and output caps in the other four are not pinned.

## Testing

```
pnpm vitest run extensions/document-extractors
```

Pinning tests: `src/__tests__/ipynb-extractor.test.ts` holds notebook extraction (markdown and code cells plus outputs, `format` of `markdown`).
