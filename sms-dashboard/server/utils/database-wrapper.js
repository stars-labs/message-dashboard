/**
 * Simple D1 database wrapper with prepared statement caching
 * Reduces overhead by preparing statements once per request
 */

export class DatabaseConnection {
  constructor(db) {
    this.db = db;
    this.preparedStatements = new Map();
    this.transactionQueue = [];
  }

  /**
   * Get or create a prepared statement (cached per request)
   */
  prepare(sql) {
    if (!this.preparedStatements.has(sql)) {
      this.preparedStatements.set(sql, this.db.prepare(sql));
    }
    return this.preparedStatements.get(sql);
  }

  /**
   * Execute a query with automatic statement caching
   */
  async execute(sql, params = []) {
    const stmt = this.prepare(sql);
    return params.length > 0 ? stmt.bind(...params).run() : stmt.run();
  }

  /**
   * Execute and get first result
   */
  async first(sql, params = []) {
    const stmt = this.prepare(sql);
    return params.length > 0 ? stmt.bind(...params).first() : stmt.first();
  }

  /**
   * Execute and get all results
   */
  async all(sql, params = []) {
    const stmt = this.prepare(sql);
    return params.length > 0 ? stmt.bind(...params).all() : stmt.all();
  }

  /**
   * Add to transaction queue
   */
  addToTransaction(sql, params = []) {
    // Store the SQL and params for later execution
    // D1 batch API needs prepared statements created fresh
    this.transactionQueue.push({ sql, params });
  }

  /**
   * Execute all queued statements as a transaction
   */
  async executeTransaction() {
    if (this.transactionQueue.length === 0) {
      return { success: true, changes: 0 };
    }

    try {
      // Create prepared statements for the batch
      const statements = this.transactionQueue.map(({ sql, params }) => {
        const stmt = this.db.prepare(sql);
        return params.length > 0 ? stmt.bind(...params) : stmt;
      });
      
      const results = await this.db.batch(statements);
      const changes = results.reduce((sum, r) => sum + (r.meta?.changes || 0), 0);
      this.transactionQueue = [];
      return { success: true, changes, results };
    } catch (error) {
      console.error('Transaction failed:', error);
      this.transactionQueue = [];
      throw error;
    }
  }

  /**
   * Clear the transaction queue without executing
   */
  clearTransaction() {
    this.transactionQueue = [];
  }

  /**
   * Get stats about cached statements (for debugging)
   */
  getStats() {
    return {
      cachedStatements: this.preparedStatements.size,
      pendingTransactions: this.transactionQueue.length
    };
  }
}

/**
 * Create a new connection wrapper for a request
 */
export function createConnection(db) {
  return new DatabaseConnection(db);
}