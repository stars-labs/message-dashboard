// Login page handler - shows a proper login page instead of the dashboard
export function serveLoginPage() {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>登录 - 短信验证码管理系统</title>
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
    }
    
    .login-container {
      background: white;
      padding: 3rem;
      border-radius: 1rem;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
      width: 100%;
      max-width: 400px;
      text-align: center;
    }
    
    h1 {
      color: #4c1d95;
      margin-bottom: 0.5rem;
      font-size: 1.875rem;
    }
    
    .subtitle {
      color: #6b7280;
      margin-bottom: 2rem;
    }
    
    .info-box {
      background: #fef3c7;
      border: 1px solid #fbbf24;
      border-radius: 0.5rem;
      padding: 1rem;
      margin-bottom: 2rem;
      text-align: left;
    }
    
    .info-box h3 {
      color: #92400e;
      font-size: 0.875rem;
      margin-bottom: 0.5rem;
    }
    
    .info-box p {
      color: #78350f;
      font-size: 0.875rem;
      line-height: 1.5;
    }
    
    .login-button {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      padding: 0.75rem 2rem;
      border-radius: 0.5rem;
      font-size: 1rem;
      font-weight: 500;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
      width: 100%;
    }
    
    .login-button:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
    }
    
    .login-button:active {
      transform: translateY(0);
    }
    
    .error-message {
      background: #fee2e2;
      border: 1px solid #f87171;
      color: #991b1b;
      padding: 0.75rem;
      border-radius: 0.375rem;
      margin-bottom: 1rem;
      font-size: 0.875rem;
    }
    
    .loading {
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 3px solid rgba(255, 255, 255, 0.3);
      border-radius: 50%;
      border-top-color: white;
      animation: spin 1s ease-in-out infinite;
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="login-container">
    <h1>短信验证码管理系统</h1>
    <p class="subtitle">请登录以继续</p>
    
    <div class="info-box">
      <h3>访问要求</h3>
      <p>您需要具有 <strong>sms</strong> 角色才能访问此系统。请使用您的 Auth0 账户登录。</p>
    </div>
    
    <div id="error-message" class="error-message" style="display: none;"></div>
    
    <button id="login-button" class="login-button" onclick="login()">
      <span id="button-text">使用 Auth0 登录</span>
      <span id="loading" class="loading" style="display: none;"></span>
    </button>
  </div>
  
  <script>
    // Check if there's an error message in the URL
    const urlParams = new URLSearchParams(window.location.search);
    const error = urlParams.get('error');
    if (error) {
      const errorDiv = document.getElementById('error-message');
      errorDiv.textContent = error === 'no_role' 
        ? '您没有访问权限。请联系管理员为您分配 sms 角色。'
        : '登录失败，请重试。';
      errorDiv.style.display = 'block';
    }
    
    function login() {
      const button = document.getElementById('login-button');
      const buttonText = document.getElementById('button-text');
      const loading = document.getElementById('loading');
      
      // Show loading state
      button.disabled = true;
      buttonText.style.display = 'none';
      loading.style.display = 'inline-block';
      
      // Redirect to Auth0 login
      window.location.href = '/api/auth/login';
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache'
    }
  });
}