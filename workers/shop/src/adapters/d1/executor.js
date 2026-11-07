export function createD1Executor(db) {
  return {
    async execute(statements) {
      const prepared = statements.map(({ sql, params = [] }) =>
        db.prepare(sql).bind(...params)
      );
      return db.batch(prepared);
    },

    async first(sql, params = []) {
      return db.prepare(sql).bind(...params).first();
    },

    async all(sql, params = []) {
      const result = await db.prepare(sql).bind(...params).all();
      return result.results || [];
    }
  };
}
