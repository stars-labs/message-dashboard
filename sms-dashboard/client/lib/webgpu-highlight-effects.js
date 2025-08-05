/**
 * WebGPU-inspired highlight effects for keyword highlighting
 */

export function applyHighlightEffects(element) {
  if (!element) return;
  
  // Apply simple color coding without animations
  const highlights = element.querySelectorAll('.keyword-highlight-webgpu');
  highlights.forEach((highlight) => {
    const color = highlight.getAttribute('data-color') || '#3B82F6';
    
    // Apply simple background with the tag color
    highlight.style.setProperty('--highlight-color', color);
    
    // Add subtle hover effect
    highlight.addEventListener('mouseenter', () => {
      highlight.style.filter = 'brightness(1.2)';
    });
    
    highlight.addEventListener('mouseleave', () => {
      highlight.style.filter = '';
    });
  });
}

export function createGlowEffect(element, color = '#3B82F6') {
  if (!element) return;
  
  // Create a glow container
  const glowContainer = document.createElement('div');
  glowContainer.className = 'webgpu-glow-container';
  glowContainer.style.cssText = `
    position: absolute;
    inset: -4px;
    border-radius: 0.5rem;
    background: conic-gradient(
      from 180deg at 50% 50%,
      ${hexToRgba(color, 0)} 0deg,
      ${color} 90deg,
      ${hexToRgba(color, 0)} 180deg,
      ${color} 270deg,
      ${hexToRgba(color, 0)} 360deg
    );
    opacity: 0.5;
    filter: blur(8px);
    animation: rotate 3s linear infinite;
    pointer-events: none;
  `;
  
  // Add rotation animation
  const rotateKeyframes = `
    @keyframes rotate {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }
  `;
  
  if (!document.querySelector(`style[data-rotate-effect]`)) {
    const style = document.createElement('style');
    style.setAttribute('data-rotate-effect', 'true');
    style.textContent = rotateKeyframes;
    document.head.appendChild(style);
  }
  
  element.style.position = 'relative';
  element.appendChild(glowContainer);
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Matrix rain effect for backgrounds
export function createMatrixRainForHighlight(container) {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    opacity: 0.1;
    pointer-events: none;
    border-radius: inherit;
  `;
  
  container.style.position = 'relative';
  container.appendChild(canvas);
  
  const ctx = canvas.getContext('2d');
  canvas.width = container.offsetWidth;
  canvas.height = container.offsetHeight;
  
  const columns = Math.floor(canvas.width / 10);
  const drops = Array(columns).fill(0);
  
  function draw() {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    ctx.fillStyle = '#00ff00';
    ctx.font = '10px monospace';
    
    for (let i = 0; i < drops.length; i++) {
      const text = String.fromCharCode(0x30A0 + Math.random() * 96);
      ctx.fillText(text, i * 10, drops[i] * 10);
      
      if (drops[i] * 10 > canvas.height && Math.random() > 0.975) {
        drops[i] = 0;
      }
      drops[i]++;
    }
  }
  
  const interval = setInterval(draw, 50);
  
  return () => {
    clearInterval(interval);
    canvas.remove();
  };
}