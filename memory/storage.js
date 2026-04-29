/**
 * Cortex Storage Layer
 * Handles all reading and writing to the brain's memory.
 * This is the only file that touches stored memories directly.
 */

import { supabase } from '../utils/supabase.js';

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
    const isDuplicate = existingIndex !== -1;

    if (isDuplicate) {
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
      chrome.storage.local.set({ memories, total: memories.length }, async () => {
        console.log("Cortex: Memory saved.");

        const sync = isDuplicate ?
          { skipped: true, reason: "duplicate" } :
          await StorageManager.syncServerMemoryCount();

        resolve({
          success: true,
          total: memories.length,
          duplicate: isDuplicate,
          serverSync: sync
        });
      });
    });
  },

  syncServerMemoryCount: async () => {
    try {
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();

      if (sessionError) throw sessionError;

      if (!session?.user?.id) {
        return { skipped: true, reason: "not_authenticated" };
      }

      const { data, error } = await supabase.rpc('increment_memory_count', {
        user_id: session.user.id
      });

      if (error) throw error;

      return { success: true, count: data };
    } catch (error) {
      console.warn("Cortex: Server memory counter sync failed.", error);

      return {
        success: false,
        reason: "sync_failed",
        message: error?.message || String(error)
      };
    }
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
