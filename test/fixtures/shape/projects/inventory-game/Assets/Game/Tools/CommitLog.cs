namespace SampleGame.Tools
{
    public static class CommitLog
    {
        public static string ParseMessage(string line)
        {
            var separator = line.IndexOf(':');
            return separator < 0 ? line : line.Substring(separator + 1).Trim();
        }
    }
}
