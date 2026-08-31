import type { CodeIndex } from "@codewise/index-core";

export interface IndexLoadContext {
  readonly configuredIndexPath?: string;
  readonly workspaceUri: string;
}

export interface LoadedIndex {
  readonly index: CodeIndex;
  readonly description: string;
}

export interface IndexSource {
  load(context: IndexLoadContext): Promise<LoadedIndex>;
}
