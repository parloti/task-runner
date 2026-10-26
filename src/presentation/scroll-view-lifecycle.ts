/** Input with terminal raw-mode support. */
interface RawModeInput {
  setRawMode?: (mode: boolean) => unknown;
}

/**
 * Change terminal raw mode while preserving the stream as the method receiver.
 * @param input Terminal input stream to update.
 * @param mode Whether raw input should be enabled.
 * @example `setTerminalRawMode(input, true)` enables interactive key handling.
 */
export function setTerminalRawMode(input: RawModeInput, mode: boolean): void {
  const setRawMode = input.setRawMode;
  if (setRawMode === undefined)
    throw new Error("Terminal raw mode is unavailable");
  setRawMode.call(input, mode);
}
