export interface CgroupMembership {
  readonly controllers: readonly string[];
  readonly path: string;
}

export interface CgroupMount {
  readonly controllers: readonly string[];
  readonly mountPoint: string;
  readonly root: string;
  readonly type: string;
}

export interface CgroupResources {
  readonly cpuLimit?: number;
  readonly cpusetLimit?: number;
  readonly memoryConstraints?: readonly MemoryConstraint[];
}

export interface CpuRange {
  readonly first: number;
  readonly last: number;
}

export interface MemoryConstraint {
  readonly currentPath: string;
  readonly limit: number;
}

export interface MemoryReading {
  readonly free: number;
  readonly total: number;
}

export interface ResolvedCgroupController {
  readonly directory: string;
  readonly mountPoint: string;
}
