declare module 'qrcode-terminal' {
  export function generate(
    text: string,
    opts?: { small?: boolean },
    callback?: (qrcode: string) => void,
  ): void;
}
