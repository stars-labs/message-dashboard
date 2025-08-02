// WebGPU Effects System for High-Tech Dashboard
export class WebGPUEffects {
  constructor(canvas) {
    this.canvas = canvas;
    this.device = null;
    this.context = null;
    this.format = null;
    this.renderPipeline = null;
    this.particleBuffer = null;
    this.uniformBuffer = null;
    this.particleCount = 1000;
    this.time = 0;
    this.initialized = false;
  }

  async init() {
    try {
      // Check WebGPU support
      if (!navigator.gpu) {
        console.warn('WebGPU not supported, falling back to CSS effects');
        return false;
      }

      // Request adapter and device
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        console.warn('No WebGPU adapter found');
        return false;
      }

      this.device = await adapter.requestDevice();
      this.context = this.canvas.getContext('webgpu');
      this.format = navigator.gpu.getPreferredCanvasFormat();

      // Configure context
      this.context.configure({
        device: this.device,
        format: this.format,
        alphaMode: 'premultiplied',
      });

      // Initialize shaders and pipeline
      await this.initializeParticleSystem();
      
      this.initialized = true;
      return true;
    } catch (error) {
      console.error('WebGPU initialization failed:', error);
      return false;
    }
  }

  async initializeParticleSystem() {
    // Vertex shader with particle system
    const vertexShaderCode = `
      struct Uniforms {
        time: f32,
        resolution: vec2<f32>,
        mousePos: vec2<f32>,
      }
      @binding(0) @group(0) var<uniform> uniforms: Uniforms;

      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) color: vec4<f32>,
        @location(1) size: f32,
      }

      @vertex
      fn main(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instanceIndex: u32) -> VertexOutput {
        var output: VertexOutput;
        
        // Generate particle positions
        let particleId = f32(instanceIndex);
        let angle = particleId * 0.1 + uniforms.time * 0.5;
        let radius = sin(particleId * 0.05 + uniforms.time * 0.3) * 0.8 + 0.2;
        
        // Cyberpunk grid effect
        let gridX = (particleId % 30.0) / 30.0 * 2.0 - 1.0;
        let gridY = floor(particleId / 30.0) / 30.0 * 2.0 - 1.0;
        
        // Mix between circular motion and grid
        let circularX = cos(angle) * radius;
        let circularY = sin(angle) * radius;
        
        let mixFactor = sin(uniforms.time * 0.2) * 0.5 + 0.5;
        let x = mix(gridX, circularX, mixFactor);
        let y = mix(gridY, circularY, mixFactor);
        
        // Add mouse influence
        let mouseInfluence = 1.0 - distance(vec2<f32>(x, y), uniforms.mousePos) * 0.5;
        x += (uniforms.mousePos.x - x) * mouseInfluence * 0.1;
        y += (uniforms.mousePos.y - y) * mouseInfluence * 0.1;
        
        // Create quad vertices
        let quadVertices = array<vec2<f32>, 6>(
          vec2<f32>(-1.0, -1.0),
          vec2<f32>(1.0, -1.0),
          vec2<f32>(-1.0, 1.0),
          vec2<f32>(-1.0, 1.0),
          vec2<f32>(1.0, -1.0),
          vec2<f32>(1.0, 1.0)
        );
        
        let quadVertex = quadVertices[vertexIndex];
        let particleSize = 0.02 * (1.0 + sin(particleId * 0.1 + uniforms.time) * 0.5);
        
        output.position = vec4<f32>(
          x + quadVertex.x * particleSize,
          y + quadVertex.y * particleSize,
          0.0,
          1.0
        );
        
        // Cyberpunk colors - purple, blue, cyan gradient
        let colorPhase = particleId * 0.1 + uniforms.time * 0.5;
        output.color = vec4<f32>(
          sin(colorPhase) * 0.3 + 0.5,           // R
          sin(colorPhase + 2.094) * 0.3 + 0.3,   // G
          sin(colorPhase + 4.189) * 0.3 + 0.8,   // B
          0.6                                      // A
        );
        
        output.size = particleSize;
        return output;
      }
    `;

    // Fragment shader with glow effect
    const fragmentShaderCode = `
      struct FragmentInput {
        @location(0) color: vec4<f32>,
        @location(1) size: f32,
      }

      @fragment
      fn main(input: FragmentInput, @builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
        // Calculate distance from center for glow effect
        let center = vec2<f32>(position.x, position.y);
        let dist = length(fract(center * 0.01) - 0.5) * 2.0;
        
        // Glow falloff
        let glow = 1.0 - smoothstep(0.0, 1.0, dist);
        
        // Enhance color with glow
        var color = input.color;
        color.a *= glow * glow;
        
        // Add bloom effect
        color.rgb *= 1.0 + glow * 2.0;
        
        return color;
      }
    `;

    // Create shaders
    const vertexShader = this.device.createShaderModule({
      code: vertexShaderCode,
    });

    const fragmentShader = this.device.createShaderModule({
      code: fragmentShaderCode,
    });

    // Create uniform buffer
    this.uniformBuffer = this.device.createBuffer({
      size: 32, // time (4) + resolution (8) + mousePos (8) + padding (12)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create bind group layout
    const bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform' },
        },
      ],
    });

    // Create bind group
    this.bindGroup = this.device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
      ],
    });

    // Create pipeline
    this.renderPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [bindGroupLayout],
      }),
      vertex: {
        module: vertexShader,
        entryPoint: 'main',
      },
      fragment: {
        module: fragmentShader,
        entryPoint: 'main',
        targets: [
          {
            format: this.format,
            blend: {
              color: {
                srcFactor: 'src-alpha',
                dstFactor: 'one',
                operation: 'add',
              },
              alpha: {
                srcFactor: 'one',
                dstFactor: 'one',
                operation: 'add',
              },
            },
          },
        ],
      },
      primitive: {
        topology: 'triangle-list',
      },
    });
  }

  updateUniforms(mouseX = 0, mouseY = 0) {
    if (!this.device || !this.uniformBuffer) return;

    const uniformData = new Float32Array([
      this.time,
      this.canvas.width,
      this.canvas.height,
      0, // padding
      mouseX * 2 - 1,
      mouseY * 2 - 1,
      0, // padding
      0, // padding
    ]);

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);
  }

  render() {
    if (!this.initialized || !this.device) return;

    this.time += 0.01;
    this.updateUniforms();

    const commandEncoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();

    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: textureView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });

    renderPass.setPipeline(this.renderPipeline);
    renderPass.setBindGroup(0, this.bindGroup);
    
    // Draw particles (6 vertices per particle)
    renderPass.draw(6, this.particleCount);
    
    renderPass.end();
    this.device.queue.submit([commandEncoder.finish()]);
  }

  destroy() {
    if (this.uniformBuffer) this.uniformBuffer.destroy();
    if (this.particleBuffer) this.particleBuffer.destroy();
    this.initialized = false;
  }
}

// Holographic text effect
export function applyHolographicEffect(element) {
  element.style.background = 'linear-gradient(45deg, #00ffff, #ff00ff, #00ffff)';
  element.style.backgroundSize = '200% 200%';
  element.style.webkitBackgroundClip = 'text';
  element.style.backgroundClip = 'text';
  element.style.webkitTextFillColor = 'transparent';
  element.style.animation = 'holographic 3s ease-in-out infinite';
}

// Glitch effect for cards
export function applyGlitchEffect(element) {
  element.classList.add('glitch-effect');
  
  // Create glitch layers
  const glitchBefore = document.createElement('div');
  const glitchAfter = document.createElement('div');
  
  glitchBefore.className = 'glitch-layer glitch-layer-1';
  glitchAfter.className = 'glitch-layer glitch-layer-2';
  
  element.style.position = 'relative';
  element.appendChild(glitchBefore);
  element.appendChild(glitchAfter);
}

// Neon glow effect
export function applyNeonGlow(element, color = '#00ffff') {
  element.style.textShadow = `
    0 0 10px ${color},
    0 0 20px ${color},
    0 0 30px ${color},
    0 0 40px ${color}
  `;
  element.style.animation = 'neon-pulse 2s ease-in-out infinite';
}

// Data stream effect for numbers
export function applyDataStreamEffect(element) {
  const originalText = element.textContent;
  if (!originalText || originalText === '0') return;
  
  const chars = '0123456789ABCDEF';
  let iterations = 0;
  
  const interval = setInterval(() => {
    element.textContent = originalText
      .split('')
      .map((char, index) => {
        if (index < iterations) {
          return originalText[index];
        }
        // Keep non-numeric characters as they are (like %)
        if (isNaN(char) && char !== '.') {
          return char;
        }
        return chars[Math.floor(Math.random() * chars.length)];
      })
      .join('');
    
    if (iterations >= originalText.length) {
      clearInterval(interval);
      // Ensure we show the exact original text at the end
      element.textContent = originalText;
    }
    
    iterations += 1 / 3;
  }, 30);
}

// Enhanced header effect with animated glow and particles
export function applyHeaderEffect(element) {
  // Add base classes
  element.classList.add('header-effect');
  
  // Create glowing particles around text
  const particleContainer = document.createElement('div');
  particleContainer.className = 'header-particles';
  element.appendChild(particleContainer);
  
  // Create multiple particles
  for (let i = 0; i < 15; i++) {
    const particle = document.createElement('div');
    particle.className = 'header-particle';
    particle.style.animationDelay = `${Math.random() * 3}s`;
    particle.style.left = `${Math.random() * 100}%`;
    particleContainer.appendChild(particle);
  }
  
  // Add scanning line effect
  const scanLine = document.createElement('div');
  scanLine.className = 'header-scan-line';
  element.appendChild(scanLine);
}

// Matrix rain effect
export function createMatrixRain(container) {
  const canvas = document.createElement('canvas');
  canvas.className = 'matrix-rain';
  canvas.style.position = 'absolute';
  canvas.style.top = '0';
  canvas.style.left = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.pointerEvents = 'none';
  canvas.style.opacity = '0.1';
  
  container.appendChild(canvas);
  
  const ctx = canvas.getContext('2d');
  canvas.width = container.offsetWidth;
  canvas.height = container.offsetHeight;
  
  const matrix = '0123456789ABCDEF';
  const matrixArray = matrix.split('');
  
  const fontSize = 10;
  const columns = canvas.width / fontSize;
  
  const drops = [];
  for (let x = 0; x < columns; x++) {
    drops[x] = 1;
  }
  
  function draw() {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.04)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    ctx.fillStyle = '#0F0';
    ctx.font = fontSize + 'px monospace';
    
    for (let i = 0; i < drops.length; i++) {
      const text = matrixArray[Math.floor(Math.random() * matrixArray.length)];
      ctx.fillText(text, i * fontSize, drops[i] * fontSize);
      
      if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) {
        drops[i] = 0;
      }
      drops[i]++;
    }
  }
  
  const animationId = setInterval(draw, 35);
  
  return () => {
    clearInterval(animationId);
    canvas.remove();
  };
}