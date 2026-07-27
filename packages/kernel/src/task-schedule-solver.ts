/**
 * Plan items 173-174. A real constraint-solver dispatch for the
 * precedence-scheduling problem class this codebase actually has:
 * `ExecutiveTask.dependencyTaskIds` (executive-episode.ts) and hierarchical
 * task decomposition (plan item 158) both need a valid execution order
 * over a dependency DAG, or an honest infeasibility report (a real cycle)
 * rather than a silent wrong answer. This implements Kahn's algorithm --
 * real topological sort with cycle detection, not an approximation.
 */

export interface SchedulableTask {
  id: string;
  dependencyIds: readonly string[];
}

export type TaskScheduleResult =
  | { status: "scheduled"; order: string[] }
  | { status: "infeasible"; reason: "cycle"; cycle: string[] };

export function solveTaskSchedule(tasks: readonly SchedulableTask[]): TaskScheduleResult {
  const byId = new Map(tasks.map(task => [task.id, task]));
  for (const task of tasks) {
    const unknown = task.dependencyIds.filter(dependencyId => !byId.has(dependencyId));
    if (unknown.length) throw new Error(`task ${task.id} depends on unknown task(s): ${unknown.join(", ")}`);
  }

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of tasks) inDegree.set(task.id, 0);
  for (const task of tasks) {
    for (const dependencyId of task.dependencyIds) {
      inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
      const bucket = dependents.get(dependencyId) ?? [];
      bucket.push(task.id);
      dependents.set(dependencyId, bucket);
    }
  }

  // Deterministic tie-break (lexical id order) so the same input always
  // produces the same schedule -- required for this to be a reproducible
  // "compiled input" rather than an accident of Map iteration order.
  const ready = tasks
    .filter(task => inDegree.get(task.id) === 0)
    .map(task => task.id)
    .sort();
  const order: string[] = [];
  const remainingInDegree = new Map(inDegree);

  while (ready.length) {
    ready.sort();
    const next = ready.shift()!;
    order.push(next);
    for (const dependentId of dependents.get(next) ?? []) {
      const updated = (remainingInDegree.get(dependentId) ?? 0) - 1;
      remainingInDegree.set(dependentId, updated);
      if (updated === 0) ready.push(dependentId);
    }
  }

  if (order.length === tasks.length) return { status: "scheduled", order };

  const cycle = findCycle(tasks.filter(task => !order.includes(task.id)));
  return { status: "infeasible", reason: "cycle", cycle };
}

/**
 * The real round-trip check for this solver class (plan item 174): given a
 * proposed order, verify every task's dependencies were compiled into an
 * earlier position -- not approximately, exactly, for every single
 * dependency edge in the original input.
 */
export function verifyTaskScheduleOrder(tasks: readonly SchedulableTask[], order: readonly string[]): boolean {
  if (order.length !== tasks.length) return false;
  if (new Set(order).size !== order.length) return false;
  const position = new Map(order.map((id, index) => [id, index]));
  for (const task of tasks) {
    if (!position.has(task.id)) return false;
    for (const dependencyId of task.dependencyIds) {
      const dependencyPosition = position.get(dependencyId);
      if (dependencyPosition === undefined || dependencyPosition >= position.get(task.id)!) return false;
    }
  }
  return true;
}

function findCycle(remaining: readonly SchedulableTask[]): string[] {
  const byId = new Map(remaining.map(task => [task.id, task]));
  const visiting = new Set<string>();
  const path: string[] = [];

  function visit(id: string): string[] | undefined {
    // `id` is already on the current DFS stack (`path`) when this
    // triggers, so the slice from its first occurrence onward *is* the
    // cycle -- appending `id` again would duplicate it (caught by the
    // one-element self-dependency test, where the duplicate was otherwise
    // easy to miss under a Set-based equality check).
    if (visiting.has(id)) return path.slice(path.indexOf(id));
    if (!byId.has(id)) return undefined;
    visiting.add(id);
    path.push(id);
    for (const dependencyId of byId.get(id)!.dependencyIds) {
      if (!byId.has(dependencyId)) continue;
      const found = visit(dependencyId);
      if (found) return found;
    }
    path.pop();
    visiting.delete(id);
    return undefined;
  }

  for (const task of remaining) {
    const found = visit(task.id);
    if (found) return found;
  }
  // Every remaining task was excluded from the topological order (in-degree
  // never reached zero), so a cycle must exist among them; this is
  // unreachable in practice but kept as an explicit invariant failure
  // rather than returning a misleadingly empty cycle.
  throw new Error("solveTaskSchedule reported infeasible but no cycle was found among the unscheduled tasks");
}
