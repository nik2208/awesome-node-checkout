/**
 * Arbitrary data associated with a transaction.
 * Extended by providers that need to persist state across async flows
 * (e.g. correlating a Satispay webhook with the original order).
 */
export interface TransactionData {
  provider: string;
  orderId?: string;
  paymentId?: string;
  createdAt: string;
  metadata?: Record<string, any>;
  [key: string]: any;
}

/**
 * Abstraction over transaction state persistence.
 * Built-in: InMemoryTransactionStore.
 * Implement this interface to use Redis, PostgreSQL, MongoDB, etc.
 */
export interface ITransactionStore {
  save(key: string, data: TransactionData): Promise<void>;
  get(key: string): Promise<TransactionData | null>;
  delete(key: string): Promise<void>;
}
