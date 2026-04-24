declare module "qrcode" {
  export type QRCodeErrorCorrectionLevel = "L" | "M" | "Q" | "H";
  export type QRCodeToStringOptions = {
    type?: "svg" | "terminal" | "utf8";
    errorCorrectionLevel?: QRCodeErrorCorrectionLevel;
    margin?: number;
    width?: number;
    color?: {
      dark?: string;
      light?: string;
    };
  };
  export function toString(data: string, opts?: QRCodeToStringOptions): Promise<string>;
  export function toDataURL(data: string, opts?: unknown): Promise<string>;
  const _default: {
    toString: typeof toString;
    toDataURL: typeof toDataURL;
  };
  export default _default;
}
