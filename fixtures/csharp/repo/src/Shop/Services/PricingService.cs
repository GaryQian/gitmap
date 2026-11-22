using Shop.Models;

namespace Shop.Services
{
    public class PricingService
    {
        public Money Total(Order order)
        {
            var sum = new Money(0m, Currency.Eur);
            foreach (OrderLine line in order.Lines)
            {
                sum = sum.Plus(line.UnitPrice.Times(line.Quantity));
            }
            return sum;
        }
    }
}
