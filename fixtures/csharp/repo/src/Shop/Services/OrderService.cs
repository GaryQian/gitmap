using System;
using System.Linq;
using Shop.Models;
using static Shop.Util.Guard;
using Store = Shop.Data.OrderRepository;

namespace Shop.Services
{
    /*
     * Places orders. PricingService is in this namespace (no using);
     * the repository comes in through an alias, the guards through a using static.
     * using Shop.Legacy;   <- inside a comment: not an import
     */
    public class OrderService : IOrderService
    {
        private const string Banner = @"
using Shop.Util;
namespace Shop.Fake { class NotAType { } }
";
        private readonly Store _store;
        private readonly PricingService _pricing;

        public OrderService(Store store, PricingService pricing)
        {
            _store = NotNull(store, nameof(store));
            _pricing = NotNull(pricing, nameof(pricing));
        }

        public Money PlaceOrder(Order order)
        {
            NotNull(order, nameof(order));
            if (!order.Lines.Any())
            {
                throw new InvalidOperationException($"Order {order.Id} has no lines; see \"using Shop.Data;\" {Banner.Length}");
            }

            var total = _pricing.Total(order);
            _store.Save(order);
            order.Customer.Remember(order);
            return total;
        }
    }
}
