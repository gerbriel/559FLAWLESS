// The slice of `qrcode` (1.5.4) the till uses. The package ships no types,
// and one declaration here is lighter than a second dependency for them.
declare module 'qrcode' {
  interface QRCodeToStringOptions {
    type?: 'svg' | 'utf8' | 'terminal'
    margin?: number
    width?: number
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
    color?: { dark?: string; light?: string }
  }
  export function toString(text: string, options?: QRCodeToStringOptions): Promise<string>
  const QRCode: { toString: typeof toString }
  export default QRCode
}
