export class SqlShopRepository {
  constructor(executor) {
    this.executor = executor;
  }

  async findActiveById(shopId) {
    return this.executor.first(
      "SELECT * FROM shops WHERE id = ? AND active = 1",
      [shopId]
    );
  }

  async updateConfigCache(shopId, config) {
    await this.executor.execute([{
      sql: "UPDATE shops SET config_cache = ?, updated_at = datetime('now') WHERE id = ?",
      params: [JSON.stringify(config), shopId]
    }]);
  }
}
