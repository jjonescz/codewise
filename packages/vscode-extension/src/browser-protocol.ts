export const indexBootstrapRequestKind = "codewise/index-bootstrap";
export const indexBootstrapReadyKind = "codewise/index-ready";
export const indexBootstrapErrorKind = "codewise/index-error";

export interface IndexBootstrapRequest {
  readonly kind: typeof indexBootstrapRequestKind;
  readonly index: ArrayBuffer;
  readonly description: string;
}

export interface IndexBootstrapReady {
  readonly kind: typeof indexBootstrapReadyKind;
}

export interface IndexBootstrapError {
  readonly kind: typeof indexBootstrapErrorKind;
  readonly message: string;
}
