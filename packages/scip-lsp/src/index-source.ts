export interface IndexLoadContext {
  readonly configuredIndexPath?: string;
  readonly workspaceUri: string;
}

export interface LoadedIndex {
  readonly bytes: Uint8Array;
  readonly description: string;
}

export interface IndexSource {
  load(context: IndexLoadContext): Promise<LoadedIndex>;
}

