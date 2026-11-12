// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

/**
 * Remembers immutable record instances that have already completed a physical
 * write in one database transaction.  Identity is deliberate: a structurally
 * equal clone may carry different non-enumerable codec state, so it must take
 * the normal write path.
 */
export class ExactTransactionWriteCache<Record extends object> {
  private readonly written = new WeakSet<Record>();

  pending(records: readonly Record[]): Record[] {
    return records.filter(record => !this.written.has(record));
  }

  commit(records: readonly Record[]): void {
    for (const record of records) this.written.add(record);
  }
}
