/**
 * mynd Storage Layer
 * Handles all reading and writing to the brain's memory.
 * This is the only file that touches stored memories directly.
 */

import { supabase } from '../utils/supabase.js';

const FREE_MEMORY_LIMIT = 200;
const DEFAULT_ENTITLEMENTS = {
  plan: 'free',
  memoryLimit: FREE_MEMORY_LIMIT,
  dailyExtractionLimit: 10,
  isPaid: false,
  memoryCount: 0
};
const ENTITLEMENTS_CACHE_KEY = 'mynd.entitlements';
const LEGACY_ENTITLEMENTS_CACHE_KEY = 'cortex.entitlements';

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
          kind: metadata.kind || memories[targetIndex].kind || inferKind(topic, metadata.category),
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
      memories[existingIndex].kind = memories[existingIndex].kind || metadata.kind || inferKind(topic, metadata.category);
    } else {
      const memoryLimit = await StorageManager.getMemoryLimit();
      if (activeCount(memories) >= memoryLimit) {
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
        kind: metadata.kind || inferKind(topic, metadata.category),
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
      console.warn("mynd: Server memory counter sync failed.", error);

      return {
        success: false,
        reason: "sync_failed",
        message: error?.message || String(error)
      };
    }
  },

  getEntitlements: async () => {
    try {
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();

      if (sessionError) throw sessionError;
      if (!session?.user?.id) return DEFAULT_ENTITLEMENTS;

      const { data, error } = await supabase.rpc('get_my_entitlements');
      if (error) throw error;

      const row = Array.isArray(data) ? data[0] : data;
      const entitlements = normalizeEntitlements(row);

      await chrome.storage.local.set({ [ENTITLEMENTS_CACHE_KEY]: entitlements });
      await chrome.storage.local.remove([LEGACY_ENTITLEMENTS_CACHE_KEY]);
      return entitlements;
    } catch (error) {
      console.warn("mynd: Entitlement lookup failed.", error);
      return StorageManager.getCachedEntitlements();
    }
  },

  getCachedEntitlements: async () => {
    return new Promise((resolve) => {
      chrome.storage.local.get([ENTITLEMENTS_CACHE_KEY, LEGACY_ENTITLEMENTS_CACHE_KEY], (result) => {
        resolve(normalizeEntitlements(result[ENTITLEMENTS_CACHE_KEY] || result[LEGACY_ENTITLEMENTS_CACHE_KEY]));
      });
    });
  },

  getMemoryLimit: async () => {
    const entitlements = await StorageManager.getEntitlements();
    return entitlements.memoryLimit;
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
    const entitlements = await StorageManager.getEntitlements();
    const total = memories.length;
    const limit = entitlements.memoryLimit;
    const remaining = Math.max(limit - total, 0);

    return {
      total,
      limit,
      remaining,
      percentage: Math.min(100, Math.round((total / limit) * 100)),
      limitReached: total >= limit,
      plan: entitlements.plan,
      isPaid: entitlements.isPaid
    };
  },

  clearAll: async () => {
    return new Promise((resolve) => {
      chrome.storage.local.set({ memories: [], total: 0 }, () => {
        console.log("mynd: Brain cleared.");
        resolve({ success: true });
      });
    });
  }
};

function persistMemories(memories, result) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ memories, total: activeCount(memories) }, async () => {
      console.log("mynd: Memory saved.");

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

function normalizeEntitlements(raw = {}) {
  const memoryLimit = Number(raw.memory_limit ?? raw.memoryLimit ?? DEFAULT_ENTITLEMENTS.memoryLimit);
  const dailyExtractionLimit = Number(
    raw.daily_extraction_limit ?? raw.dailyExtractionLimit ?? DEFAULT_ENTITLEMENTS.dailyExtractionLimit
  );
  const plan = String(raw.plan || DEFAULT_ENTITLEMENTS.plan).trim().toLowerCase();

  return {
    plan,
    memoryLimit: Number.isFinite(memoryLimit) && memoryLimit > 0 ? memoryLimit : DEFAULT_ENTITLEMENTS.memoryLimit,
    dailyExtractionLimit: Number.isFinite(dailyExtractionLimit) && dailyExtractionLimit > 0 ?
      dailyExtractionLimit :
      DEFAULT_ENTITLEMENTS.dailyExtractionLimit,
    isPaid: Boolean(raw.is_paid ?? raw.isPaid ?? plan !== 'free'),
    memoryCount: Number(raw.memory_count ?? raw.memoryCount ?? DEFAULT_ENTITLEMENTS.memoryCount)
  };
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

function inferKind(topic, category) {
  const value = String(category || topic || 'personal').trim().toLowerCase();
  if (['domain', 'correction', 'rule'].includes(value)) return value;
  if (['project', 'tool', 'workflow', 'constraint'].includes(value)) return 'project';
  return 'personal';
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
