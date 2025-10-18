// Type definitions for Bull/BullMQ/Bee-Queue compatibility
// Uses loose typing to be compatible with actual library types

/* eslint-disable @typescript-eslint/no-explicit-any */

// Use any for maximum compatibility with actual queue libraries
// The queue detector will determine the actual type at runtime
export type AnyQueue = any;

// Export type aliases for documentation purposes
// These are all `any` to avoid type conflicts with actual libraries
export type BullQueue = any;
export type BullMQQueue = any;
export type BeeQueue = any;
export type BullJob = any;
export type BullMQJob = any;
export type BeeJob = any;
export type BullEventHandler = any;
export type BullFailedHandler = any;
export type BullMQEventHandler = any;
export type BullMQFailedHandler = any;
export type BeeEventHandler = any;
export type BeeFailedHandler = any;

// Type guards for runtime detection
export function isBullQueue(queue: AnyQueue): boolean {
  // Bull has 'process' method which BullMQ doesn't (BullMQ uses Worker class)
  return (
    queue &&
    'add' in queue &&
    'process' in queue &&
    'name' in queue &&
    !('createJob' in queue)
  );
}

export function isBullMQQueue(queue: AnyQueue): boolean {
  // BullMQ has 'opts' with defaultJobOptions and doesn't have 'process' method
  return (
    queue &&
    'add' in queue &&
    'on' in queue &&
    !('process' in queue) &&
    !('createJob' in queue)
  );
}

export function isBeeQueue(queue: AnyQueue): boolean {
  return queue && 'createJob' in queue;
}
