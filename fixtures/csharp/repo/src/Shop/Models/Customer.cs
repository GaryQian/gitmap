using System.Collections.Generic;

namespace Shop.Models;

// File-scoped namespace. Order is declared in Order.cs, same namespace, no using.
public record Customer(string Name, string Email)
{
    public List<Order> History { get; } = new();

    public void Remember(Order order)
    {
        History.Add(order);
    }
}
