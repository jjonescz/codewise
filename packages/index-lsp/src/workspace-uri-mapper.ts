import { normalizeRelativePath } from "@codewise/index-core";
import type { InitializeParams } from "vscode-languageserver";
import { URI, Utils } from "vscode-uri";

function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/u, "") : path;
}

export class WorkspaceUriMapper {
  readonly #root: URI;
  readonly #rootPath: string;

  public static fromInitializeParams(params: InitializeParams): WorkspaceUriMapper {
    const rootUri = params.workspaceFolders?.[0]?.uri ?? params.rootUri;
    if (rootUri === null || rootUri === undefined || rootUri === "") {
      throw new Error("A workspace folder or root URI is required.");
    }
    return new WorkspaceUriMapper(rootUri);
  }

  public constructor(rootUri: string) {
    this.#root = URI.parse(rootUri);
    this.#rootPath = trimTrailingSlash(this.#root.path);
  }

  public get rootUri(): string {
    return this.#root.toString();
  }

  public toRelativePath(documentUri: string): string | undefined {
    const document = URI.parse(documentUri);
    if (
      document.scheme !== this.#root.scheme
      || document.authority !== this.#root.authority
    ) {
      return undefined;
    }

    const prefix = this.#rootPath === "/" ? "/" : `${this.#rootPath}/`;
    if (!document.path.startsWith(prefix)) {
      return undefined;
    }
    return normalizeRelativePath(document.path.slice(prefix.length));
  }

  public toDocumentUri(relativePath: string): string {
    const normalized = normalizeRelativePath(relativePath);
    return Utils.joinPath(this.#root, ...normalized.split("/")).toString();
  }
}
