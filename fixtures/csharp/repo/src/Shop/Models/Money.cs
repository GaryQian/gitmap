using System.Globalization;

namespace Shop.Models
{
    public enum Currency
    {
        Eur,
        Usd,
    }

    public readonly struct Money
    {
        public Money(decimal amount, Currency currency)
        {
            Amount = amount;
            Currency = currency;
        }

        public decimal Amount { get; }
        public Currency Currency { get; }

        public Money Plus(Money other)
        {
            return new Money(Amount + other.Amount, Currency);
        }

        public Money Times(int factor)
        {
            return new Money(Amount * factor, Currency);
        }

        public string Format()
        {
            return Amount.ToString("0.00", CultureInfo.InvariantCulture) + " " + Currency;
        }
    }
}
