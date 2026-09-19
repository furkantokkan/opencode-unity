using System.Collections.Generic;
using UnityEngine;

namespace SampleGame.Inventory
{
    public sealed class InventoryGrid : MonoBehaviour
    {
        private readonly InventoryModel m_model = new InventoryModel();

        public void RefreshSlots()
        {
            var slots = new List<InventorySlot>(m_model.Capacity);
            for (var index = 0; index < m_model.Capacity; index++)
            {
                slots.Add(new InventorySlot(index));
            }
        }
    }
}
