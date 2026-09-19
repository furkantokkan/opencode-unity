using NUnit.Framework;
using SampleGame.Inventory;

namespace SampleGame.Tests
{
    public sealed class SlotCountTests
    {
        [Test]
        public void CapacityIsPositive()
        {
            Assert.That(new InventoryModel().Capacity, Is.GreaterThan(0));
        }
    }
}
