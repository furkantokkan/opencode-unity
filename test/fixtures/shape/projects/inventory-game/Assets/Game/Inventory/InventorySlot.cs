namespace SampleGame.Inventory
{
    public readonly struct InventorySlot
    {
        public InventorySlot(int index)
        {
            Index = index;
        }

        public int Index { get; }
    }
}
