<script>
  import { onMount, onDestroy } from 'svelte';
  import { WebGPUEffects } from './webgpu-effects.js';
  
  let canvas;
  let webgpuEffects;
  let animationFrame;
  let mouseX = 0.5;
  let mouseY = 0.5;
  
  onMount(async () => {
    if (!canvas) return;
    
    // Initialize WebGPU
    webgpuEffects = new WebGPUEffects(canvas);
    
    // Reduce particle count on mobile for better performance and visibility
    if (window.innerWidth <= 768) {
      webgpuEffects.particleCount = 300; // Reduce from 1000
    }
    
    const initialized = await webgpuEffects.init();
    
    if (!initialized) {
      console.log('WebGPU not available, using fallback effects');
      // Add fallback CSS effects
      canvas.parentElement.classList.add('digital-rain', 'hex-pattern');
      return;
    }
    
    // Handle mouse movement
    const handleMouseMove = (e) => {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      mouseX = (e.clientX - rect.left) / rect.width;
      mouseY = (e.clientY - rect.top) / rect.height;
    };
    
    window.addEventListener('mousemove', handleMouseMove);
    
    // Handle resize
    const handleResize = () => {
      if (!canvas) return;
      // Use document dimensions for mobile to ensure full coverage
      const width = Math.max(window.innerWidth, document.documentElement.clientWidth);
      const height = Math.max(window.innerHeight, document.documentElement.clientHeight);
      canvas.width = width;
      canvas.height = height;
    };
    
    handleResize();
    window.addEventListener('resize', handleResize);
    
    // Animation loop
    const animate = () => {
      if (webgpuEffects) {
        webgpuEffects.updateUniforms(mouseX, mouseY);
        webgpuEffects.render();
      }
      animationFrame = requestAnimationFrame(animate);
    };
    
    animate();
    
    // Cleanup
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('resize', handleResize);
      if (animationFrame) {
        cancelAnimationFrame(animationFrame);
      }
      if (webgpuEffects) {
        webgpuEffects.destroy();
      }
    };
  });
  
  onDestroy(() => {
    if (animationFrame) {
      cancelAnimationFrame(animationFrame);
    }
    if (webgpuEffects) {
      webgpuEffects.destroy();
    }
  });
</script>

<div class="webgpu-container">
  <canvas bind:this={canvas} class="webgpu-canvas"></canvas>
</div>

<style>
  .webgpu-container {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: -999 !important;
    overflow: hidden;
  }
  
  .webgpu-canvas {
    width: 100%;
    height: 100%;
    opacity: 0.7;
  }
  
  /* Mobile-specific fixes */
  @media (max-width: 768px) {
    .webgpu-container {
      width: 100vw !important;
      height: 100vh !important;
      min-height: 100vh !important;
      transform: translateZ(0); /* Force GPU acceleration */
      -webkit-transform: translateZ(0);
    }
    
    .webgpu-canvas {
      width: 100vw !important;
      height: 100vh !important;
      min-height: 100vh !important;
    }
  }
  
  /* Fallback gradient background */
  .webgpu-container::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: 
      radial-gradient(ellipse at top left, rgba(0, 255, 255, 0.1) 0%, transparent 50%),
      radial-gradient(ellipse at bottom right, rgba(255, 0, 255, 0.1) 0%, transparent 50%),
      linear-gradient(to bottom, #0a0a0a, #1a1a2e);
    z-index: -1;
  }
</style>