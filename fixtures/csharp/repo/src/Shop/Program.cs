using System;
using Shop.Data;
using Shop.Models;
using Shop.Services;

namespace Shop
{
    public static class Program
    {
        public static int Main(string[] args)
        {
            var repository = new OrderRepository();
            IOrderService service = new OrderService(repository, new PricingService());

            var customer = new Customer("Ada", "ada@example.com");
            var order = new Order(customer);
            order.Add("keyboard", new Money(49.90m, Currency.Eur), 2);

            var total = service.PlaceOrder(order);
            Console.WriteLine($"Order {order.Id} placed: {total.Format()} ({repository.Count} stored)");
            return 0;
        }
    }
}
