export function getAPIDocsHTML() {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SMS Dashboard API</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        
        .container {
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
            padding: 40px;
            max-width: 600px;
            width: 100%;
            text-align: center;
        }
        
        h1 {
            color: #333;
            margin-bottom: 20px;
            font-size: 2.5em;
        }
        
        .subtitle {
            color: #666;
            margin-bottom: 30px;
            font-size: 1.2em;
        }
        
        .status {
            display: inline-flex;
            align-items: center;
            gap: 10px;
            background: #f0f9ff;
            padding: 10px 20px;
            border-radius: 30px;
            margin-bottom: 30px;
            color: #0369a1;
        }
        
        .status-dot {
            width: 10px;
            height: 10px;
            background: #22c55e;
            border-radius: 50%;
            animation: pulse 2s infinite;
        }
        
        @keyframes pulse {
            0% {
                box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7);
            }
            70% {
                box-shadow: 0 0 0 10px rgba(34, 197, 94, 0);
            }
            100% {
                box-shadow: 0 0 0 0 rgba(34, 197, 94, 0);
            }
        }
        
        .links {
            display: flex;
            gap: 20px;
            justify-content: center;
            margin-bottom: 40px;
        }
        
        .btn {
            display: inline-block;
            padding: 12px 30px;
            background: #667eea;
            color: white;
            text-decoration: none;
            border-radius: 8px;
            font-weight: 500;
            transition: all 0.3s ease;
        }
        
        .btn:hover {
            background: #5a67d8;
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(102, 126, 234, 0.3);
        }
        
        .btn-secondary {
            background: #e0e7ff;
            color: #667eea;
        }
        
        .btn-secondary:hover {
            background: #c7d2fe;
        }
        
        .info {
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 20px;
            text-align: left;
        }
        
        .info h3 {
            color: #475569;
            margin-bottom: 10px;
            font-size: 1.1em;
        }
        
        .info p {
            color: #64748b;
            line-height: 1.6;
        }
        
        .code {
            background: #1e293b;
            color: #e2e8f0;
            padding: 15px;
            border-radius: 8px;
            font-family: 'Courier New', monospace;
            font-size: 0.9em;
            overflow-x: auto;
            margin-top: 10px;
        }
        
        .endpoints {
            text-align: left;
            margin-top: 30px;
        }
        
        .endpoint {
            background: #f1f5f9;
            border-left: 4px solid #667eea;
            padding: 12px 16px;
            margin-bottom: 10px;
            border-radius: 4px;
            font-family: monospace;
            font-size: 0.9em;
        }
        
        .method {
            color: #059669;
            font-weight: bold;
        }
        
        .footer {
            margin-top: 40px;
            color: #94a3b8;
            font-size: 0.9em;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>📱 SMS Dashboard API</h1>
        <p class="subtitle">Real-time SMS Management System</p>
        
        <div class="status">
            <div class="status-dot"></div>
            <span>API Online</span>
        </div>
        
        <div class="links">
            <a href="https://sexy.qzz.io" class="btn">Go to Dashboard</a>
            <a href="/api/health" class="btn btn-secondary">API Health</a>
        </div>
        
        <div class="info">
            <h3>🔐 Authentication Required</h3>
            <p>This API requires authentication. Users should access the dashboard through the main application.</p>
        </div>
        
        <div class="info">
            <h3>🔧 For Developers</h3>
            <p>If you're integrating with this API, you'll need an API key for the control endpoints.</p>
            <div class="code">
X-API-Key: your-api-key-here
            </div>
        </div>
        
        <div class="endpoints">
            <h3 style="color: #334155; margin-bottom: 15px;">Available Endpoints</h3>
            <div class="endpoint">
                <span class="method">GET</span> /api/health
            </div>
            <div class="endpoint">
                <span class="method">POST</span> /api/auth/login
            </div>
            <div class="endpoint">
                <span class="method">GET</span> /api/phones
            </div>
            <div class="endpoint">
                <span class="method">GET</span> /api/messages
            </div>
            <div class="endpoint">
                <span class="method">POST</span> /api/control/messages
            </div>
            <div class="endpoint">
                <span class="method">POST</span> /api/control/phones
            </div>
        </div>
        
        <div class="footer">
            <p>Powered by Cloudflare Workers & Auth0</p>
        </div>
    </div>
</body>
</html>
`;
}