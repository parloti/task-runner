import type { ProgressModel } from "./progress-model";

/**
 * Render a persistent task listing for the final terminal output.
 * @param model Progress state for the selected task graph.
 * @param frame Animation frame used for running task markers.
 * @param maxTasks Maximum number of visible task rows.
 * @param color Whether the listing should use status colors.
 * @returns Final task rows without surrounding terminal chrome.
 * @example `renderPersistentFrame(model, 0, 100, false)` returns plain task rows.
 */
export function renderPersistentFrame(
  model: ProgressModel,
  frame: number,
  maxTasks: number,
  color: boolean,
): string {
  return model.frame(frame, maxTasks, { color });
}
