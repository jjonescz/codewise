import type { Occurrence } from "@scip-code/scip";
import { ScipIndexError } from "./errors.js";
import type { ScipPosition, ScipRange } from "./types.js";

function assertCoordinate(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ScipIndexError(`Invalid ${name} coordinate: ${value}`);
  }
}

function createRange(
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number
): ScipRange {
  assertCoordinate(startLine, "start line");
  assertCoordinate(startCharacter, "start character");
  assertCoordinate(endLine, "end line");
  assertCoordinate(endCharacter, "end character");

  if (
    endLine < startLine
    || (endLine === startLine && endCharacter < startCharacter)
  ) {
    throw new ScipIndexError(
      `SCIP range ends before it starts: ${startLine}:${startCharacter}-${endLine}:${endCharacter}`
    );
  }

  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter }
  };
}

export function decodeOccurrenceRange(occurrence: Occurrence): ScipRange {
  switch (occurrence.typedRange.case) {
    case "singleLineRange": {
      const value = occurrence.typedRange.value;
      return createRange(value.line, value.startCharacter, value.line, value.endCharacter);
    }
    case "multiLineRange": {
      const value = occurrence.typedRange.value;
      return createRange(
        value.startLine,
        value.startCharacter,
        value.endLine,
        value.endCharacter
      );
    }
    case undefined:
      break;
  }

  if (occurrence.range.length === 3) {
    const [line, startCharacter, endCharacter] = occurrence.range;
    return createRange(line!, startCharacter!, line!, endCharacter!);
  }

  if (occurrence.range.length === 4) {
    const [startLine, startCharacter, endLine, endCharacter] = occurrence.range;
    return createRange(startLine!, startCharacter!, endLine!, endCharacter!);
  }

  throw new ScipIndexError(
    `SCIP occurrence range must contain three or four coordinates; found ${occurrence.range.length}.`
  );
}

export function comparePositions(left: ScipPosition, right: ScipPosition): number {
  return left.line - right.line || left.character - right.character;
}

export function compareRanges(left: ScipRange, right: ScipRange): number {
  return comparePositions(left.start, right.start) || comparePositions(left.end, right.end);
}

export function containsPosition(range: ScipRange, position: ScipPosition): boolean {
  if (comparePositions(range.start, range.end) === 0) {
    return comparePositions(range.start, position) === 0;
  }

  return (
    comparePositions(range.start, position) <= 0
    && comparePositions(position, range.end) < 0
  );
}

export function compareContainingRanges(left: ScipRange, right: ScipRange): number {
  const startComparison = comparePositions(right.start, left.start);
  return startComparison || comparePositions(left.end, right.end);
}

