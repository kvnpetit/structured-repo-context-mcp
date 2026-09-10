import { randomUUID } from "node:crypto";

export interface TaskOwner {
  pid: number;
  instanceId: string;
}

const localOwners = new Set<string>();

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Lack of permission is not evidence that the owner has stopped.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function createTaskOwner(): TaskOwner {
  const owner = { pid: process.pid, instanceId: randomUUID() };
  localOwners.add(owner.instanceId);
  return owner;
}

export function releaseTaskOwner(owner: TaskOwner): void {
  localOwners.delete(owner.instanceId);
}

export function isTaskOwnerAlive(owner: TaskOwner | undefined): boolean {
  if (owner === undefined) {
    return false;
  }
  return owner.pid === process.pid
    ? localOwners.has(owner.instanceId)
    : isProcessAlive(owner.pid);
}
