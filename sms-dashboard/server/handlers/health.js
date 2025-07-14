export const healthHandler = {
  async check(request) {
    const { env } = request;
    
    try {
      // Test database connection
      const result = await env.DB.prepare('SELECT 1 as test').first();
      
      return new Response(JSON.stringify({
        status: 'healthy',
        database: result ? 'connected' : 'error',
        timestamp: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString()
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};