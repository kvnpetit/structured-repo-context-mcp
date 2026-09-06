public sealed class InventoryService
{
    public bool ReserveInventory(string sku, int quantity)
    {
        return quantity > 0 && sku.Length > 0;
    }
}
