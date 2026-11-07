import { createD1Executor } from "./adapters/d1/executor.js";
import { SqlOrderRepository } from "./adapters/sql/order-repository.js";
import { SqlShopRepository } from "./adapters/sql/shop-repository.js";
import { createHandler } from "./http/handler.js";
import { OrderService } from "./services/order-service.js";

export default {
  async fetch(request, env) {
    const executor = createD1Executor(env.orders);
    const orderService = new OrderService(new SqlOrderRepository(executor));
    const shopStore = new SqlShopRepository(executor);
    const handler = createHandler({ orderService, shopStore });
    return handler(request);
  }
};
