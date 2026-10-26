import { styleText } from "node:util";

import type { CompiledTask, TaskEvent, TaskId, TaskStatus } from "../domain";

import {
  colors,
  type LiveAppearance,
  liveMarkers,
  markers,
  type ProgressRow,
  spinner,
  taskLabel,
} from "./progress-model-rendering";
import { validationScope } from "./progress-model-scopes";
import { updateGroupTiming } from "./progress-model-timing";

const statusOrder: readonly TaskStatus[] = [
  "pending",
  "ready",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "blocked",
  "cancelled",
];

export class ProgressModel {
  private readonly events = new Map<TaskId, TaskEvent>();
  private readonly groupDescendants = new Map<TaskId, Set<TaskId>>();
  private readonly groupDurations = new Map<TaskId, number>();
  private readonly rows: ProgressRow[] = [];
  private readonly started = new Map<TaskId, number>();

  constructor(
    graph: ReadonlyMap<TaskId, CompiledTask>,
    target: string,
    private readonly collapse = true,
  ) {
    const root = graph.values().find((task) => task.id === target);
    if (root === undefined)
      throw new Error(`Missing progress target: ${target}`);
    const seen = new Set<TaskId>();
    const reachable = new Set<TaskId>();
    const scopes = new Map<TaskId, string>();
    const inspect = (task: CompiledTask): void => {
      if (reachable.has(task.id)) return;
      reachable.add(task.id);
      const dependencies = task.dependsOn.map((id) => {
        const dependency = graph.get(id);
        if (dependency === undefined)
          throw new Error(`Missing progress dependency: ${id}`);
        return dependency;
      });
      const scope = validationScope(task, dependencies);
      if (scope !== undefined) scopes.set(task.id, scope);
      for (const dependency of dependencies) inspect(dependency);
    };
    inspect(root);
    const owners = new Map<TaskId, TaskId>();
    const requireTask = (id: TaskId): CompiledTask => {
      const task = graph.get(id);
      if (task === undefined)
        throw new Error(`Missing progress dependency: ${id}`);
      return task;
    };
    for (const [group, scope] of scopes) {
      const claim = (task: CompiledTask): void => {
        if (task.package !== scope || owners.has(task.id)) return;
        owners.set(task.id, group);
        for (const dependency of task.dependsOn) claim(requireTask(dependency));
      };
      for (const dependency of requireTask(group).dependsOn)
        claim(requireTask(dependency));
    }
    const visit = (
      task: CompiledTask,
      depth: number,
      siblings: ProgressRow[],
      scope: string,
      owner?: TaskId,
    ): void => {
      if (owners.has(task.id) && owners.get(task.id) !== owner) return;
      if (seen.has(task.id)) return;
      seen.add(task.id);
      const row: ProgressRow = {
        children: [],
        depth,
        hidden: false,
        scope,
        task,
      };
      const dependencies = task.dependsOn.map((id) => requireTask(id));
      if (task.run === undefined) {
        siblings.push(row);
        this.rows.push(row);
        const childScope = scopes.get(task.id) ?? task.package;
        const childOwner = scopes.has(task.id) ? task.id : owner;
        for (const dependency of dependencies)
          visit(dependency, depth + 1, row.children, childScope, childOwner);
        if (
          task !== root &&
          dependencies.length > 0 &&
          row.children.length === 0 &&
          dependencies.every(
            (dependency) => dependency.package !== task.package,
          )
        ) {
          siblings.pop();
          row.hidden = true;
        }
      } else {
        for (const dependency of dependencies)
          visit(dependency, depth, siblings, scope, owner);
        siblings.push(row);
        this.rows.push(row);
      }
    };
    visit(root, 0, [], ".");
    for (const row of this.rows) {
      if (row.hidden || row.task.run !== undefined) continue;
      const descendants = new Set<TaskId>();
      const collect = (child: ProgressRow): void => {
        descendants.add(child.task.id);
        for (const nested of child.children) collect(nested);
      };
      collect(row);
      this.groupDescendants.set(row.task.id, descendants);
    }
  }

  eventLine(event: TaskEvent): string | undefined {
    if (event.status === "pending" || event.status === "ready")
      return undefined;
    const row = this.rows.find((item) => item.task.id === event.taskId);
    if (row === undefined)
      throw new Error(`Unknown progress task: ${event.taskId}`);
    return row.hidden ? undefined : this.line(row, 0);
  }

  frame(frame: number, limit = 100, appearance?: LiveAppearance): string {
    const visible: ProgressRow[] = [];
    let collapsedDepth: number | undefined;
    for (const row of this.rows) {
      if (row.hidden) continue;
      if (collapsedDepth !== undefined && row.depth > collapsedDepth) continue;
      collapsedDepth = undefined;
      visible.push(row);
      if (
        this.collapse &&
        row.task.run === undefined &&
        ["pending", "succeeded"].includes(this.status(row))
      ) {
        collapsedDepth = row.depth;
      }
    }
    if (visible.length <= limit)
      return visible.map((row) => this.line(row, frame, appearance)).join("\n");
    const selected = new Set<ProgressRow>();
    const priorities = visible.toSorted((left, right) => {
      const priority = (row: ProgressRow): number =>
        ["blocked", "cancelled", "failed", "ready", "running"].includes(
          this.status(row),
        )
          ? 0
          : 1;
      return priority(left) - priority(right);
    });
    for (const row of priorities) {
      const index = visible.indexOf(row);
      const branch = [row];
      let depth = row.depth;
      for (let i = index - 1; i >= 0; i--) {
        const parent = visible[i];
        if (parent === undefined || !(parent.depth < depth)) {
          continue;
        }

        branch.push(parent);
        depth = parent.depth;
      }
      if (new Set([...selected, ...branch]).size <= limit) {
        for (const item of branch) selected.add(item);
      }
    }
    return [
      ...visible
        .filter((row) => selected.has(row))
        .map((row) => this.line(row, frame, appearance)),
      `... ${String(visible.length - selected.size)} more tasks`,
    ].join("\n");
  }

  summary(): string {
    const counts: Record<TaskStatus, number> = {
      blocked: 0,
      cancelled: 0,
      failed: 0,
      pending: 0,
      ready: 0,
      running: 0,
      skipped: 0,
      succeeded: 0,
    };
    const commands = this.rows.filter((row) => row.task.run !== undefined);
    for (const row of commands)
      counts[this.events.get(row.task.id)?.status ?? "pending"]++;
    return [
      `Tasks: ${String(commands.length)}`,
      ...statusOrder
        .filter((status) => counts[status] > 0)
        .map((status) => `${status}: ${String(counts[status])}`),
    ].join(" | ");
  }

  update(event: TaskEvent): void {
    if (this.rows.every((row) => row.task.id !== event.taskId)) {
      throw new Error(`Unknown progress task: ${event.taskId}`);
    }
    this.events.set(event.taskId, event);
    updateGroupTiming(
      event,
      this.groupDescendants,
      this.started,
      this.groupDurations,
    );
  }

  private line(
    row: ProgressRow,
    frame: number,
    appearance?: LiveAppearance,
  ): string {
    const status = this.status(row);
    const event = this.events.get(row.task.id);
    const start = this.started.get(row.task.id);
    const duration =
      event?.durationMs ??
      this.groupDurations.get(row.task.id) ??
      (start === undefined ? undefined : Date.now() - start);
    let marker =
      appearance === undefined
        ? status === "running"
          ? "|/-\\".charAt(frame % 4)
          : markers[status]
        : status === "running"
          ? spinner.charAt(frame % spinner.length)
          : liveMarkers[status];
    if (appearance?.color)
      marker = styleText(colors[status], marker, { validateStream: false });
    return `${"  ".repeat(row.depth)}${marker} ${taskLabel(row.task, row.scope)} (${status}${duration === undefined ? "" : `, ${(duration / 1000).toFixed(1)}s`})`;
  }

  private status(row: ProgressRow): TaskStatus {
    const status = this.events.get(row.task.id)?.status ?? "pending";
    return status === "pending" && this.started.has(row.task.id)
      ? "running"
      : status;
  }
}
