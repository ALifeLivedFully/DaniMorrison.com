function runStatement(db, { sql, params = [] }) {
  const prepared = db.prepare(sql);
  if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
    return { results: prepared.all(...params) };
  }
  const result = prepared.run(...params);
  return {
    meta: {
      changes: Number(result.changes),
      last_row_id: Number(result.lastInsertRowid)
    }
  };
}

export function createSqliteExecutor(db) {
  return {
    async execute(statements) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const entry of statements) {
          results.push(runStatement(db, entry));
        }
        db.exec("COMMIT");
        return results;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    },

    async first(sql, params = []) {
      return db.prepare(sql).get(...params) ?? null;
    },

    async all(sql, params = []) {
      return db.prepare(sql).all(...params);
    }
  };
}
