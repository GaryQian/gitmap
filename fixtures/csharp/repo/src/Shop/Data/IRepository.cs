using System;

namespace Shop.Data
{
    public interface IRepository<T>
    {
        void Save(T item);
        T Find(Guid id);
        int Count { get; }
    }
}
