using System;
using System.Collections.Generic;

namespace Shop.Models
{
    /// <summary>An order and its lines. Customer and Money live in this namespace: no using needed.</summary>
    public class Order
    {
        private readonly List<OrderLine> _lines = new List<OrderLine>();

        public Order(Customer customer)
        {
            Id = Guid.NewGuid();
            Customer = customer;
        }

        public Guid Id { get; }
        public Customer Customer { get; }
        public IReadOnlyList<OrderLine> Lines => _lines;

        public void Add(string product, Money unitPrice, int quantity)
        {
            _lines.Add(new OrderLine(product, unitPrice, quantity));
        }
    }

    public class OrderLine
    {
        public OrderLine(string product, Money unitPrice, int quantity)
        {
            Product = product;
            UnitPrice = unitPrice;
            Quantity = quantity;
        }

        public string Product { get; }
        public Money UnitPrice { get; }
        public int Quantity { get; }
    }
}
