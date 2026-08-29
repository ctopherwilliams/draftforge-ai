export function writerLeaseMatchesBinding(
  lease,
  binding,
  bindingGeneration,
  now = Date.now(),
) {
  return Boolean(binding
    && lease
    && lease.appTabId === binding.appTabId
    && lease.commandCenterSessionId === binding.commandCenterSessionId
    && lease.commandCenterDocumentId === binding.commandCenterDocumentId
    && lease.bindingGeneration === bindingGeneration
    && Number.isFinite(lease.expiresAt)
    && lease.expiresAt > now);
}

export function renewExistingWriterLease(
  lease,
  binding,
  bindingGeneration,
  now,
  ttlMs,
) {
  if (!writerLeaseMatchesBinding(lease, binding, bindingGeneration, now)) return null;
  return { ...lease, expiresAt: now + ttlMs };
}
