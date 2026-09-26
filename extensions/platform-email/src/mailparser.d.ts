declare module 'mailparser' {
  export interface AddressObject {
    value: Array<{ address?: string; name?: string }>;
    text?: string;
  }
  export interface ParsedMail {
    from?: AddressObject;
    subject?: string;
    text?: string;
    html?: string | false;
    messageId?: string;
    /** The ROOT part's raw header lines, in delivered order, one entry per
     *  occurrence (a repeated header appears once per copy). `line` is the
     *  whole folded header, name included. */
    headerLines?: Array<{ key: string; line: string }>;
  }
  export function simpleParser(source: Buffer | string): Promise<ParsedMail>;
}
