import { Data } from "effect";

export class InvalidInput extends Data.TaggedError("InvalidInput")<{ readonly message: string }> {}
export class NotInstalled extends Data.TaggedError("NotInstalled")<{ readonly message: string }> {}
export class Timeout extends Data.TaggedError("Timeout")<{ readonly message: string }> {}
export class IoError extends Data.TaggedError("IoError")<{ readonly message: string }> {}
export class NonZeroExit extends Data.TaggedError("NonZeroExit")<{
  readonly code: number | null;
  readonly message: string;
}> {}

export type KhalError = InvalidInput | NotInstalled | Timeout | IoError | NonZeroExit;

export const ioError = (u: unknown): IoError =>
  new IoError({ message: u instanceof Error ? u.message : String(u) });
