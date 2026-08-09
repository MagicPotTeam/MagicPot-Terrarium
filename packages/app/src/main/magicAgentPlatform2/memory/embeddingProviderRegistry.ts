import type { SemanticEmbeddingProvider } from '@shared/magicAgentPlatform2/memory'

export class EmbeddingProviderRegistry {
  private readonly providers = new Map<
    string,
    { provider: SemanticEmbeddingProvider; version: string }
  >()

  register(provider: SemanticEmbeddingProvider, version = '1'): () => void {
    if (
      !provider.id.trim() ||
      !provider.model.trim() ||
      !Number.isInteger(provider.dimension) ||
      provider.dimension <= 0
    ) {
      throw new Error('Invalid embedding provider metadata')
    }
    if (this.providers.has(provider.id))
      throw new Error(`Embedding provider already registered: ${provider.id}`)
    this.providers.set(provider.id, { provider, version })
    return () => {
      if (this.providers.get(provider.id)?.provider === provider) this.providers.delete(provider.id)
    }
  }

  get(id: string): SemanticEmbeddingProvider | undefined {
    return this.providers.get(id)?.provider
  }

  unregister(id: string): void {
    this.providers.delete(id)
  }

  listRegistrations(): Array<{
    id: string
    version: string
    remote: boolean
    model: string
    dimension: number
  }> {
    return [...this.providers.values()].map(({ provider, version }) => ({
      id: provider.id,
      version,
      remote: provider.remote,
      model: provider.model,
      dimension: provider.dimension
    }))
  }

  require(id: string): SemanticEmbeddingProvider {
    const provider = this.get(id)
    if (!provider) throw new Error(`Embedding provider unavailable: ${id}`)
    return provider
  }

  validate(
    provider: SemanticEmbeddingProvider,
    response: { model: string; dimension: number; vectors: number[][] },
    expectedCount: number
  ): void {
    if (response.model !== provider.model || response.dimension !== provider.dimension) {
      throw new Error(`Embedding provider model/dimension mismatch for ${provider.id}`)
    }
    if (
      response.vectors.length !== expectedCount ||
      response.vectors.some(
        (vector) =>
          vector.length !== provider.dimension || vector.some((value) => !Number.isFinite(value))
      )
    ) {
      throw new Error(`Embedding provider returned invalid vectors for ${provider.id}`)
    }
  }
}
