import { stripVTControlCharacters, styleText } from "node:util";
import { taskName } from "../domain/task-name.js";

import type {
  CompiledTask,
  TaskEvent,
  TaskId,
  TaskStatus,
} from "../domain/types.js";

const safeText = (value: string): string =>
  stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}]/gu, " ");

function taskLabel(task: CompiledTask, scope: string): string {
  const name = taskName(task);
  return safeText(
    task.package === "." || task.package === scope
      ? name
      : `${task.package} > ${name}`,
  );
}

interface ProgressRow {
  readonly task: CompiledTask;
  readonly depth: number;
  readonly children: ProgressRow[];
  readonly scope: string;
  hidden: boolean;
}

function validationScope(
  task: CompiledTask,
  dependencies: readonly CompiledTask[],
): string | undefined {
  const packagePath = dependencies[0]?.package;
  if (
    task.run === undefined &&
    packagePath !== undefined &&
    task.id === `validate:${packagePath.split("/").at(-1)}` &&
    dependencies.every((dependency) => dependency.package === packagePath)
  )
    return packagePath;
  return undefined;
}

const markers: Record<TaskStatus, string> = {
  pending: ".",
  ready: ">",
  running: "*",
  succeeded: "+",
  failed: "x",
  skipped: "-",
  blocked: "!",
  cancelled: "~",
};

const liveMarkers: Record<TaskStatus, string> = {
  pending: "\u25a1",
  ready: "\u203a",
  running: "\u280b",
  succeeded: "\u2714",
  failed: "\u2716",
  skipped: "\u2193",
  blocked: "\u26a0",
  cancelled: "\u25a0",
};

const colors = {
  pending: "gray",
  ready: "yellow",
  running: "cyan",
  succeeded: "green",
  failed: "red",
  skipped: "gray",
  blocked: "yellow",
  cancelled: "magenta",
} as const satisfies Record<TaskStatus, string>;

const spinner = "\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f";

interface LiveAppearance {
  readonly color: boolean;
}

export class ProgressModel {
  private readonly rows: ProgressRow[] = [];
  private readonly events = new Map<TaskId, TaskEvent>();
  private readonly started = new Map<TaskId, number>();
  private readonly groupDescendants = new Map<TaskId, Set<TaskId>>();
  private readonly groupDurations = new Map<TaskId, number>();

  constructor(
    graph: ReadonlyMap<TaskId, CompiledTask>,
    target: string,
    private readonly collapse = true,
  ) {
    const root = [...graph.values()].find((task) => task.id === target);
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
    for (const [group, scope] of scopes) {
      const claim = (task: CompiledTask): void => {
        if (task.package !== scope || owners.has(task.id)) return;
        owners.set(task.id, group);
        for (const dependency of task.dependsOn) claim(graph.get(dependency)!);
      };
      for (const dependency of graph.get(group)!.dependsOn)
        claim(graph.get(dependency)!);
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
        task,
        depth,
        children: [],
        scope,
        hidden: false,
      };
      const dependencies = task.dependsOn.map((id) => graph.get(id)!);
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
      if (row.hidden) continue;
      if (row.task.run !== undefined) continue;
      const descendants = new Set<TaskId>();
      const collect = (child: ProgressRow): void => {
        descendants.add(child.task.id);
        for (const nested of child.children) collect(nested);
      };
      collect(row);
      this.groupDescendants.set(row.task.id, descendants);
    }
  }

  update(event: TaskEvent): void {
    if (!this.rows.some((row) => row.task.id === event.taskId)) {
      throw new Error(`Unknown progress task: ${event.taskId}`);
    }
    this.events.set(event.taskId, event);
    const now = Date.now();
    if (event.status === "running") {
      this.started.set(event.taskId, now);
      for (const [group, descendants] of this.groupDescendants) {
        if (descendants.has(event.taskId) && !this.started.has(group))
          this.started.set(group, now);
      }
    }
    if (
      this.groupDescendants.has(event.taskId) &&
      !["pending", "ready", "running"].includes(event.status)
    ) {
      this.groupDurations.set(
        event.taskId,
        now - (this.started.get(event.taskId) ?? now),
      );
    }
  }

  private status(row: ProgressRow): TaskStatus {
    const status = this.events.get(row.task.id)?.status ?? "pending";
    if (status === "pending" && this.started.has(row.task.id)) return "running";
    return status;
  }

  summary(): string {
    const counts: Record<TaskStatus, number> = {
      pending: 0,
      ready: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      blocked: 0,
      cancelled: 0,
    };
    const commands = this.rows.filter((row) => row.task.run !== undefined);
    for (const row of commands)
      counts[this.events.get(row.task.id)?.status ?? "pending"]++;
    return [
      `Tasks: ${commands.length}`,
      ...Object.entries(counts)
        .filter(([, count]) => count > 0)
        .map(([status, count]) => `${status}: ${count}`),
    ].join(" | ");
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
          ? "|/-\\"[frame % 4]!
          : markers[status]
        : status === "running"
          ? spinner[frame % spinner.length]!
          : liveMarkers[status];
    if (appearance?.color)
      marker = styleText(colors[status], marker, { validateStream: false });
    return `${"  ".repeat(row.depth)}${marker} ${taskLabel(row.task, row.scope)} (${status}${duration === undefined ? "" : `, ${(duration / 1000).toFixed(1)}s`})`;
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
    const priorities = [...visible].sort((left, right) => {
      const priority = (row: ProgressRow): number =>
        ["running", "ready", "failed", "blocked", "cancelled"].includes(
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
        const parent = visible[i]!;
        if (parent.depth < depth) {
          branch.push(parent);
          depth = parent.depth;
        }
      }
      if (new Set([...selected, ...branch]).size <= limit) {
        for (const item of branch) selected.add(item);
      }
    }
    return [
      ...visible
        .filter((row) => selected.has(row))
        .map((row) => this.line(row, frame, appearance)),
      `... ${visible.length - selected.size} more tasks`,
    ].join("\n");
  }

  eventLine(event: TaskEvent): string | undefined {
    if (event.status === "pending" || event.status === "ready")
      return undefined;
    const row = this.rows.find((item) => item.task.id === event.taskId);
    if (row === undefined)
      throw new Error(`Unknown progress task: ${event.taskId}`);
    if (row.hidden) return undefined;
    return this.line(row, 0);
  }
}
