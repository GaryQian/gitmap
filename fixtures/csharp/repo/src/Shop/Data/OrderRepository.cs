using System;
using System.Collections.Generic;
using System.IO;
using Shop.Models;
using Shop.Util;

namespace Shop.Data
{
    public class OrderRepository : IRepository<Order>
    {
        private readonly Dictionary<Guid, Order> _orders = new Dictionary<Guid, Order>();

        public int Count => _orders.Count;

        public void Save(Order item)
        {
            Guard.NotNull(item, nameof(item));
            _orders[item.Id] = item;
        }

        public Order Find(Guid id)
        {
            return _orders[id];
        }

        public void Export(string path)
        {
            // A using statement and a using declaration: neither is an import.
            using (var stream = File.Create(path))
            {
                using var writer = new StreamWriter(stream);
                foreach (var order in _orders.Values)
                {
                    writer.WriteLine(order.Id.ToString().Shorten(8));
                }
            }
        }
    }
}
