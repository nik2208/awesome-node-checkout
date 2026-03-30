import { ITransactionStore, TransactionData } from '../interfaces/transaction-store.interface';
/**
 * Built-in in-memory transaction store.
 * Suitable for development and single-process deployments.
 *
 * For production multi-instance deployments, implement `ITransactionStore`
 * backed by Redis, PostgreSQL, MongoDB, etc.
 */
export declare class InMemoryTransactionStore implements ITransactionStore {
    private readonly store;
    save(key: string, data: TransactionData): Promise<void>;
    get(key: string): Promise<TransactionData | null>;
    delete(key: string): Promise<void>;
    /** Returns the number of stored transactions (useful for testing) */
    get size(): number;
}
//# sourceMappingURL=in-memory-transaction.store.d.ts.map