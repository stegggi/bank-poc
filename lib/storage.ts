// lib/storage.ts
export function getUserKey(userId: string) {
  return {
    indexKey: `acctIndex:${userId}`,
    archiveKey: `archive:${userId}`,
  };
}

export function getAccountIndex(userId: string): number {
  const { indexKey } = getUserKey(userId);
  const raw = typeof window !== 'undefined' ? localStorage.getItem(indexKey) : null;
  return raw ? Number(raw) : 0;
}

export function setAccountIndex(userId: string, idx: number) {
  const { indexKey } = getUserKey(userId);
  if (typeof window !== 'undefined') localStorage.setItem(indexKey, String(idx));
}

export function pushArchive(userId: string, addr: string) {
  const { archiveKey } = getUserKey(userId);
  if (typeof window === 'undefined') return;
  const raw = localStorage.getItem(archiveKey);
  const list = raw ? JSON.parse(raw) as string[] : [];
  if (!list.includes(addr)) list.unshift(addr);
  localStorage.setItem(archiveKey, JSON.stringify(list.slice(0, 5))); // keep last 5
}

export function getArchive(userId: string): string[] {
  const { archiveKey } = getUserKey(userId);
  const raw = typeof window !== 'undefined' ? localStorage.getItem(archiveKey) : null;
  return raw ? JSON.parse(raw) as string[] : [];
}
