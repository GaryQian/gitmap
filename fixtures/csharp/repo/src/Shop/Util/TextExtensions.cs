namespace Shop.Util
{
    public static class TextExtensions
    {
        public static string Shorten(this string text, int length)
        {
            return text.Length <= length ? text : text.Substring(0, length);
        }
    }
}
