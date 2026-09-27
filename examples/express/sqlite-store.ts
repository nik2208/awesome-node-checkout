import Database from 'better-sqlite3';
import { ITransactionStore, TransactionData } from 'awesome-node-checkout';

export class SqliteTransactionStore implements ITransactionStore {
    private db: Database.Database;

    constructor(dbPath: string = 'transactions.sqlite') {
        this.db = new Database(dbPath);
        // Ensure table exists
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS transactions (
                orderId TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
    }

    async save(orderId: string, data: TransactionData): Promise<void> {
        const stmt = this.db.prepare(
            'INSERT OR REPLACE INTO transactions (orderId, data) VALUES (?, ?)'
        );
        stmt.run(orderId, JSON.stringify(data));
    }

    async get(orderId: string): Promise<TransactionData | null> {
        const stmt = this.db.prepare('SELECT data FROM transactions WHERE orderId = ?');
        const row = stmt.get(orderId) as { data: string } | undefined;
        if (row && row.data) {
            return JSON.parse(row.data) as TransactionData;
        }
        return null;
    }

    async delete(orderId: string): Promise<void> {
        const stmt = this.db.prepare('DELETE FROM transactions WHERE orderId = ?');
        stmt.run(orderId);
    }
}
