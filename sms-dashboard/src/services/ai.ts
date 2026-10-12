export interface AIService {
  generateText(prompt: string, options?: any): Promise<string>;
  generateEmbedding(text: string): Promise<number[]>;
}

/**
 * Cloudflare AI Workers implementation
 */
export class CloudflareAI implements AIService {
  constructor(private env: any) {}
  
  async generateText(prompt: string, options: any = {}): Promise<string> {
    if (!this.env.AI) {
      throw new Error('Cloudflare AI not available');
    }
    
    const response = await this.env.AI.run('@cf/meta/llama-3-8b-instruct', {
      prompt,
      ...options
    });
    
    return response.response || response;
  }
  
  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.env.AI) {
      throw new Error('Cloudflare AI not available');
    }
    
    const response = await this.env.AI.run('@cf/baai/bge-base-en-v1.5', {
      text: [text]
    });
    
    return response.data?.[0] || [];
  }
}

/**
 * Mock AI service for local development
 */
export class MockAI implements AIService {
  async generateText(prompt: string): Promise<string> {
    return `Mock response to: ${prompt}`;
  }
  
  async generateEmbedding(text: string): Promise<number[]> {
    // Return a mock embedding vector
    return Array(768).fill(0).map(() => Math.random());
  }
}

/**
 * Create AI service based on environment
 */
export function createAIService(env?: any): AIService {
  if (env?.AI) {
    console.log('[AI] Using Cloudflare AI service');
    return new CloudflareAI(env);
  }
  
  console.log('[AI] Using mock AI service for development');
  return new MockAI();
}