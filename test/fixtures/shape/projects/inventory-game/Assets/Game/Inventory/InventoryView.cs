using UnityEngine;

namespace SampleGame.Inventory
{
    public sealed class InventoryView : MonoBehaviour
    {
        [SerializeField] private InventoryGrid m_grid;

        private void Update()
        {
            m_grid.RefreshSlots();
        }
    }
}
