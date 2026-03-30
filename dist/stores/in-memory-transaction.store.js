"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryTransactionStore = void 0;
/**
 * Built-in in-memory transaction store.
 * Suitable for development and single-process deployments.
 *
 * For production multi-instance deployments, implement `ITransactionStore`
 * backed by Redis, PostgreSQL, MongoDB, etc.
 */
class InMemoryTransactionStore {
    constructor() {
        this.store = new Map();
    }
    async save(key, data) {
        this.store.set(key, { ...data });
    }
    async get(key) {
        return this.store.get(key) ?? null;
    }
    async delete(key) {
        this.store.delete(key);
    }
    /** Returns the number of stored transactions (useful for testing) */
    get size() {
        return this.store.size;
    }
}
exports.InMemoryTransactionStore = InMemoryTransactionStore;
//# sourceMappingURL=in-memory-transaction.store.js.map