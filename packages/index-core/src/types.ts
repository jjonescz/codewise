export interface IndexPosition {
  readonly line: number;
  readonly character: number;
}

export interface IndexRange {
  readonly start: IndexPosition;
  readonly end: IndexPosition;
}

export interface IndexLocation {
  readonly relativePath?: string;
  readonly uri?: string;
  readonly range: IndexRange;
}

export interface IndexHover {
  readonly contents: unknown;
  readonly range?: IndexRange;
}

export interface IndexStatistics {
  readonly documentCount: number;
  readonly occurrenceCount: number;
  readonly completedAnswerCount: number;
  readonly answerLocationCount: number;
  readonly completedHoverCount: number;
}

export type SqlValue = string | number | bigint | Uint8Array | null;
export type SqlRow = Readonly<Record<string, SqlValue>>;

export interface SqlDatabase {
  all(sql: string, parameters?: readonly SqlValue[]): readonly SqlRow[];
  close(): void;
}
