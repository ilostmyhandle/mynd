/**
 * Cortex Storage Layer
 * Handles all reading and writing to the brain's memory.
 * This is the only file that touches stored memories directly.
 */

const MEMORY_LIMIT = 200;

const StorageManager = {

  getMemories: async () => {
    return new Promise((resolve) => {
      chrome.storage.local.get(['memories'], (result) => {
        resolve(result.memories || []);
      });
    });
  },

  saveMemory: async (fact, platform, topic) => {
    let memories = await StorageManager.getMemories();

    const existingIndex = memories.findIndex(
      (m) => m.fact.toLowerCase() === fact.toLowerCase()
    );

    if (existingIndex !== -1) {
      memories[existingIndex].uses += 1;
      memories[existingIndex].timestamp = new Date().toISOString();
    } else {
      if (memories.length >= MEMORY_LIMIT) {
        return { success: false, reason: "limit_reached" };
      }

      const newMemory = {
        id: crypto.randomUUID(),
        fact: fact,
        platform: platform,
        topic: topic || "general",
        timestamp: new Date().toISOString(),
        uses: 1
      };

      memories.unshift(newMemory);
    }

    return new Promise((resolve) => {
      chrome.storage.local.set({ memories, total: memories.length }, () => {
        console.log("Cortex: Memory saved.");
        resolve({ success: true, total: memories.length });
      });
    });
  },

  findRelevantMemories: async (contextText) => {
    const memories = await StorageManager.getMemories();

    if (!contextText) return memories.slice(0, 5);

    const filtered = memories.filter((m) =>
      contextText.toLowerCase().includes(m.topic.toLowerCase()) ||
      m.fact.toLowerCase().split(" ").some(
        (word) => word.length > 3 && contextText.toLowerCase().includes(word)
      )
    );

    return filtered.slice(0, 10);
  },

  deleteMemory: async (memoryId) => {
    let memories = await StorageManager.getMemories();

    memories = memories.filter((m) => m.id !== memoryId);

    return new Promise((resolve) => {
      chrome.storage.local.set({ memories, total: memories.length }, () => {
        resolve({ success: true });
      });
    });
  },

  getStats: async () => {
    const memories = await StorageManager.getMemories();
    const total = memories.length;

    return {
      total,
      limit: MEMORY_LIMIT,
      remaining: MEMORY_LIMIT - total,
      percentage: Math.round((total / MEMORY_LIMIT) * 100),
      limitReached: total >= MEMORY_LIMIT
    };
  },

  clearAll: async () => {
    return new Promise((resolve) => {
      chrome.storage.local.set({ memories: [], total: 0 }, () => {
        console.log("Cortex: Brain cleared.");
        resolve({ success: true });
      });
    });
  }
};

export default StorageManager;