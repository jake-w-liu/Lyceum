/**
 * Move one map entry to a new key without leaking an entry already stored at
 * that key. The collision callback runs before the displaced value is removed,
 * allowing resource-owning maps (for example Monaco text models) to dispose it.
 */
export function rekeyMapEntry<T>(
  map: Map<string, T>,
  from: string,
  to: string,
  onDisplaced: (value: T) => void,
): boolean {
  const value = map.get(from);
  if (value === undefined) return false;
  const displaced = map.get(to);
  if (displaced !== undefined && displaced !== value) {
    onDisplaced(displaced);
    map.delete(to);
  }
  map.delete(from);
  map.set(to, value);
  return true;
}

/**
 * Reconcile a path move against a resource-owning map. A usable source is
 * re-keyed normally. When the source is absent or cannot be preserved, any
 * destination entry is stale relative to the authoritative moved document and
 * must be released so the caller can recreate it from that document.
 *
 * An unusable source deliberately remains under `from`; the caller's normal
 * closed-entry sweep still owns its cleanup (and may need its old key/URI).
 */
export function reconcileMapMove<T>(
  map: Map<string, T>,
  from: string,
  to: string,
  isSourceUsable: (value: T) => boolean,
  onDisplaced: (value: T) => void,
): T | undefined {
  const value = map.get(from);
  if (value === undefined || !isSourceUsable(value)) {
    const displaced = map.get(to);
    if (displaced !== undefined) {
      onDisplaced(displaced);
      map.delete(to);
    }
    return undefined;
  }
  rekeyMapEntry(map, from, to, onDisplaced);
  return value;
}
