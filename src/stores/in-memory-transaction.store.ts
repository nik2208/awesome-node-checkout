import { ITransactionStore, TransactionData } from '../interfaces/transaction-store.interface';

/**
 * Built-in in-memory transaction store.
 * Suitable for development and single-process deployments.
 *
 * For production multi-instance deployments, implement `ITransactionStore`
 * backed by Redis, PostgreSQL, MongoDB, etc.
 */
export class InMemoryTransactionStore implements ITransactionStore {
  private readonly store: Map<string, TransactionData> = new Map();

  async save(key: string, data: TransactionData): Promise<void> {
    this.store.set(key, { ...data });
  }

  async get(key: string): Promise<TransactionData | null> {
    return this.store.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  /** Returns the number of stored transactions (useful for testing) */
  get size(): number {
    return this.store.size;
  }
}
