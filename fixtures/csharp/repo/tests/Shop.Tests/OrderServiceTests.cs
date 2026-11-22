using Shop.Data;
using Shop.Models;
using Shop.Services;
using Xunit;

namespace Shop.Tests
{
    public class OrderServiceTests
    {
        [Fact]
        public void PlacingAnOrderStoresIt()
        {
            var repository = new OrderRepository();
            var service = new OrderService(repository, new PricingService());
            var order = new Order(new Customer("Grace", "grace@example.com"));
            order.Add("mouse", new Money(20m, Currency.Usd), 3);

            var total = service.PlaceOrder(order);

            Assert.Equal(60m, total.Amount);
            Assert.Equal(1, repository.Count);
        }
    }
}
