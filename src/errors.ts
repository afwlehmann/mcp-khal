import { Data } from "effect";

export class InvalidInput extends Data.TaggedError("InvalidInput")<{ readonly message: string }> {}
export class IoError extends Data.TaggedError("IoError")<{ readonly message: string }> {}

/** Every failure of the server: bad input, or a file system problem. */
export type AppError = InvalidInput | IoError;

export const ioError = (u: unknown): IoError =>
  new IoError({ message: u instanceof Error ? u.message : String(u) });
