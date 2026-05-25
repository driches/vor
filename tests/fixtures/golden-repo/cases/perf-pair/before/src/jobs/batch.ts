interface Item {
  id: string;
}

declare function processOne(item: Item): Promise<void>;

export async function processBatch(items: Item[]): Promise<void> {
  // PLANT_ANCHOR: sync-in-async-loop
  console.log('batch complete');
}
