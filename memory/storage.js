/**
 * Cortex Storage Layer
 * Handles all reading and writing to the brain's memory.
 * This is the only file that touches stored memories directly.
 */

import { supabase } from '../utils/supabase.js';

const MEMORY_LIMIT = 200;

const StorageManager = {

  getMemories: async () => {
    const memories = await StorageManager.getAllMemories();
    return memories.filter((memory) => !memory.archived);
  },

  getAllMemories: async () => {
    return new Promise((resolve) => {
      chrome.storage.local.get(['memories'], (result) => {
        resolve(result.memories || []);
      });
    });
  },

  saveMemory: async (fact, platform, topic, metadata = {}) => {
    let memories = await StorageManager.getAllMemories();
    const now = new Date().toISOString();
    const normalizedFact = normalizeFact(fact);
    const hash = await hashMemory(normalizedFact);
    const action = normalizeAction(metadata.action);
    const target = normalizeFact(metadata.target);

    if (action === 'delete') {
      const targetIndex = findMemoryIndex(memories, { normalizedFact, hash, target, metadata });
      if (targetIndex === -1) {
        return { success: true, total: activeCount(memories), skipped: true, reason: 'delete_target_not_found' };
      }

      memories[targetIndex] = {
        ...memories[targetIndex],
        archived: true,
        archivedAt: now,
        updatedAt: now,
        archiveReason: fact.trim()
      };

      return persistMemories(memories, { success: true, archived: true, action: 'delete' });
    }

    if (action === 'update') {
      const targetIndex = findMemoryIndex(memories, { normalizedFact, hash, target, metadata });
      if (targetIndex !== -1) {
        memories[targetIndex] = {
          ...memories[targetIndex],
          hash,
          fact: fact.trim(),
          platform,
          topic: topic || memories[targetIndex].topic || 'general',
          entity: metadata.entity || memories[targetIndex].entity || '',
          category: metadata.category || memories[targetIndex].category || topic || 'general',
          sessionId: metadata.sessionId || memories[targetIndex].sessionId || '',
          timestamp: now,
          updatedAt: now,
          archived: false,
          uses: Number(memories[targetIndex].uses || 0) + 1
        };

        return persistMemories(memories, { success: true, updated: true, action: 'update' });
      }
    }

    const existingIndex = memories.findIndex(
      (m) => !m.archived && (m.hash === hash || normalizeFact(m.fact) === normalizedFact)
    );
    const isDuplicate = existingIndex !== -1;

    if (isDuplicate) {
      memories[existingIndex].uses += 1;
      memories[existingIndex].timestamp = now;
      memories[existingIndex].updatedAt = now;
      memories[existingIndex].hash = memories[existingIndex].hash || hash;
      memories[existingIndex].entity = memories[existingIndex].entity || metadata.entity || '';
      memories[existingIndex].category = memories[existingIndex].category || metadata.category || topic || 'general';
    } else {
      if (activeCount(memories) >= MEMORY_LIMIT) {
        return { success: false, reason: "limit_reached" };
      }

      const newMemory = {
        id: crypto.randomUUID(),
        hash,
        fact: fact.trim(),
        platform: platform,
        topic: topic || "general",
        entity: metadata.entity || '',
        category: metadata.category || topic || "general",
        sessionId: metadata.sessionId || '',
        timestamp: now,
        createdAt: now,
        updatedAt: now,
        lastRetrieved: '',
        retrievals: 0,
        uses: 1,
        archived: false
      };

      memories.unshift(newMemory);
    }

    return persistMemories(memories, {
      success: true,
      duplicate: isDuplicate,
      action: isDuplicate ? 'duplicate' : 'add',
      syncServerCount: !isDuplicate
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
    let memories = await StorageManager.getAllMemories();

    memories = memories.filter((m) => m.id !== memoryId);

    return new Promise((resolve) => {
      chrome.storage.local.set({ memories, total: activeCount(memories) }, () => {
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

function persistMemories(memories, result) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ memories, total: activeCount(memories) }, async () => {
      console.log("Cortex: Memory saved.");

      const sync = result.syncServerCount ?
        await StorageManager.syncServerMemoryCount() :
        { skipped: true, reason: result.action || "no_new_memory" };

      resolve({
        ...result,
        total: activeCount(memories),
        serverSync: sync
      });
    });
  });
}

function findMemoryIndex(memories, { normalizedFact, hash, target, metadata }) {
  const normalizedEntity = normalizeFact(metadata.entity);

  return memories.findIndex((memory) => {
    if (memory.archived) return false;
    if (memory.hash === hash) return true;
    if (normalizeFact(memory.fact) === normalizedFact) return true;
    if (target && normalizeFact(memory.fact) === target) return true;
    if (target && normalizeFact(memory.entity) === target) return true;
    if (normalizedEntity && normalizeFact(memory.entity) === normalizedEntity) return true;
    return false;
  });
}

function normalizeAction(action) {
  const value = String(action || 'add').trim().toLowerCase();
  return ['add', 'update', 'delete'].includes(value) ? value : 'add';
}

function activeCount(memories) {
  return memories.filter((memory) => !memory.archived).length;
}

function normalizeFact(fact) {
  return String(fact || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

async function hashMemory(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export default StorageManager;
