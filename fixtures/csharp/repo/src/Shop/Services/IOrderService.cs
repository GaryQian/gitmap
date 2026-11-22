using Shop.Models;

namespace Shop.Services
{
    public interface IOrderService
    {
        Money PlaceOrder(Order order);
    }
}
