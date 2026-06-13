import type { ProviderType } from '../schemas.js'
import type { ICLIAdapter, AdapterFactory } from './types.js'

/**
 * Registry of CLI adapter factories keyed by provider type.
 */
const adapters = new Map<ProviderType, AdapterFactory>()

/**
 * Register an adapter factory for a given provider.
 */
export function registerAdapter(provider: ProviderType, factory: AdapterFactory): void {
  adapters.set(provider, factory)
}

/**
 * Look up and instantiate an adapter for the given provider.
 * Returns a new adapter instance, or undefined if no factory is registered.
 */
export function getAdapter(provider: ProviderType): ICLIAdapter | undefined {
  const factory = adapters.get(provider)
  return factory ? factory() : undefined
}

/**
 * Check whether an adapter is registered for the given provider.
 */
export function hasAdapter(provider: ProviderType): boolean {
  return adapters.has(provider)
}

/**
 * List all registered provider types.
 */
export function listProviders(): ProviderType[] {
  return [...adapters.keys()]
}

/**
 * Remove all registered adapters. Useful for testing.
 */
export function clearAdapters(): void {
  adapters.clear()
}
