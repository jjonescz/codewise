export interface ScipPosition {
  readonly line: number;
  readonly character: number;
}

export interface ScipRange {
  readonly start: ScipPosition;
  readonly end: ScipPosition;
}

export interface ScipLocation {
  readonly relativePath: string;
  readonly range: ScipRange;
}

export interface ScipHover {
  readonly range: ScipRange;
  readonly signature?: string;
  readonly signatureLanguage?: string;
  readonly documentation: readonly string[];
}

export interface ScipIndexStatistics {
  readonly documentCount: number;
  readonly occurrenceCount: number;
  readonly definitionCount: number;
  readonly externalSymbolCount: number;
  readonly unresolvedOccurrenceCount: number;
  readonly ambiguousSymbolCount: number;
}

export interface ScipValidationReport {
  readonly statistics: ScipIndexStatistics;
  readonly warnings: readonly string[];
}

