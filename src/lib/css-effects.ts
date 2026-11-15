export interface CssEffect {
  id: string;
  name: string;
  description: string;
  category: string;
  css: string;
  html: string;
  previewBg?: string;
}

export const categories = [
  { id: "all", label: "All Effects", icon: "✨" },
  { id: "buttons", label: "Buttons", icon: "🔘" },
  { id: "hover", label: "Hover Effects", icon: "👆" },
  { id: "text", label: "Text Effects", icon: "✍️" },
  { id: "cards", label: "Cards", icon: "🃏" },
  { id: "loaders", label: "Loaders", icon: "⏳" },
  { id: "shadows", label: "Shadows & Borders", icon: "🎭" },
  { id: "animations", label: "Animations", icon: "🎬" },
  { id: "gradients", label: "Gradients", icon: "🌈" },
  { id: "glassmorphism", label: "Glassmorphism", icon: "🪟" },
] as const;

export type CategoryId = (typeof categories)[number]["id"];

export const cssEffects: CssEffect[] = [
  // ===== BUTTONS =====
  {
    id: "btn-glow",
    name: "Glow Button",
    description: "A button with a pulsating glow effect that draws attention",
    category: "buttons",
    css: `.glow-btn {
  padding: 12px 32px;
  border: none;
  border-radius: 8px;
  background: linear-gradient(135deg, #667eea, #764ba2);
  color: white;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  position: relative;
  overflow: hidden;
  transition: all 0.3s ease;
  box-shadow: 0 0 20px rgba(102, 126, 234, 0.4);
}

.glow-btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 0 40px rgba(102, 126, 234, 0.6),
              0 0 80px rgba(118, 75, 162, 0.3);
}

.glow-btn::after {
  content: '';
  position: absolute;
  inset: -2px;
  border-radius: 10px;
  background: linear-gradient(135deg, #667eea, #764ba2, #667eea);
  z-index: -1;
  animation: glow-pulse 2s ease-in-out infinite;
  filter: blur(8px);
  opacity: 0.6;
}

@keyframes glow-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 0.8; }
}`,
    html: `<button class="glow-btn">Glow Button</button>`,
  },
  {
    id: "btn-border-animation",
    name: "Animated Border Button",
    description: "Button with a rotating gradient border animation",
    category: "buttons",
    css: `.border-anim-btn {
  padding: 12px 32px;
  border: none;
  border-radius: 8px;
  background: #1a1a2e;
  color: white;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  position: relative;
  z-index: 1;
}

.border-anim-btn::before {
  content: '';
  position: absolute;
  inset: -2px;
  border-radius: 10px;
  background: conic-gradient(
    from var(--angle, 0deg),
    #ff6b6b, #feca57, #48dbfb, #ff9ff3, #ff6b6b
  );
  z-index: -2;
  animation: rotate-border 3s linear infinite;
}

.border-anim-btn::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 8px;
  background: #1a1a2e;
  z-index: -1;
}

@property --angle {
  syntax: '<angle>';
  initial-value: 0deg;
  inherits: false;
}

@keyframes rotate-border {
  to { --angle: 360deg; }
}`,
    html: `<button class="border-anim-btn">Animated Border</button>`,
    previewBg: "#0a0a1a",
  },
  {
    id: "btn-ripple",
    name: "Ripple Button",
    description: "Button with a material-design-inspired ripple effect on click",
    category: "buttons",
    css: `.ripple-btn {
  padding: 12px 32px;
  border: none;
  border-radius: 8px;
  background: #e74c3c;
  color: white;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  position: relative;
  overflow: hidden;
  transition: background 0.3s;
}

.ripple-btn:hover {
  background: #c0392b;
}

.ripple-btn::after {
  content: '';
  position: absolute;
  width: 100%;
  height: 100%;
  top: 0;
  left: 0;
  background: radial-gradient(circle, rgba(255,255,255,0.3) 10%, transparent 10.01%);
  background-repeat: no-repeat;
  background-position: 50%;
  transform: scale(10);
  opacity: 0;
  transition: transform 0.5s, opacity 0.8s;
}

.ripple-btn:active::after {
  transform: scale(0);
  opacity: 1;
  transition: 0s;
}`,
    html: `<button class="ripple-btn">Click Me</button>`,
  },
  {
    id: "btn-slide-fill",
    name: "Slide Fill Button",
    description: "Button with a background that slides in from the left on hover",
    category: "buttons",
    css: `.slide-fill-btn {
  padding: 12px 32px;
  border: 2px solid #BF5AF2;
  border-radius: 8px;
  background: transparent;
  color: #BF5AF2;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  position: relative;
  overflow: hidden;
  transition: color 0.3s ease;
  z-index: 1;
}

.slide-fill-btn:hover {
  color: white;
}

.slide-fill-btn::before {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: #BF5AF2;
  transition: left 0.3s ease;
  z-index: -1;
}

.slide-fill-btn:hover::before {
  left: 0;
}`,
    html: `<button class="slide-fill-btn">Slide Fill</button>`,
  },
  {
    id: "btn-3d-press",
    name: "3D Press Button",
    description: "A 3D button that appears to press down on click",
    category: "buttons",
    css: `.btn-3d {
  padding: 12px 32px;
  border: none;
  border-radius: 8px;
  background: #3498db;
  color: white;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  box-shadow:
    0 6px 0 #2980b9,
    0 8px 10px rgba(0, 0, 0, 0.15);
  transform: translateY(0);
  transition: all 0.1s ease;
}

.btn-3d:active {
  transform: translateY(4px);
  box-shadow:
    0 2px 0 #2980b9,
    0 4px 6px rgba(0, 0, 0, 0.15);
}`,
    html: `<button class="btn-3d">Press Me</button>`,
  },

  // ===== HOVER EFFECTS =====
  {
    id: "hover-scale-rotate",
    name: "Scale & Rotate",
    description: "Element scales up and rotates slightly on hover",
    category: "hover",
    css: `.hover-scale-rotate {
  width: 100px;
  height: 100px;
  border-radius: 12px;
  background: linear-gradient(135deg, #f093fb, #f5576c);
  transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
  cursor: pointer;
}

.hover-scale-rotate:hover {
  transform: scale(1.15) rotate(5deg);
  box-shadow: 0 10px 30px rgba(245, 87, 108, 0.4);
}`,
    html: `<div class="hover-scale-rotate"></div>`,
  },
  {
    id: "hover-flip",
    name: "3D Flip Card",
    description: "Card that flips to reveal its back face on hover",
    category: "hover",
    css: `.flip-container {
  width: 140px;
  height: 100px;
  perspective: 600px;
  cursor: pointer;
}

.flip-inner {
  width: 100%;
  height: 100%;
  position: relative;
  transform-style: preserve-3d;
  transition: transform 0.6s ease;
}

.flip-container:hover .flip-inner {
  transform: rotateY(180deg);
}

.flip-front, .flip-back {
  position: absolute;
  inset: 0;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 14px;
  backface-visibility: hidden;
}

.flip-front {
  background: linear-gradient(135deg, #667eea, #764ba2);
  color: white;
}

.flip-back {
  background: linear-gradient(135deg, #f093fb, #f5576c);
  color: white;
  transform: rotateY(180deg);
}`,
    html: `<div class="flip-container">
  <div class="flip-inner">
    <div class="flip-front">Front</div>
    <div class="flip-back">Back</div>
  </div>
</div>`,
  },
  {
    id: "hover-shine",
    name: "Shine Sweep",
    description: "A sweeping shine effect that glides across on hover",
    category: "hover",
    css: `.shine-box {
  width: 140px;
  height: 90px;
  border-radius: 12px;
  background: linear-gradient(135deg, #2c3e50, #3498db);
  position: relative;
  overflow: hidden;
  cursor: pointer;
}

.shine-box::after {
  content: '';
  position: absolute;
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  background: linear-gradient(
    to right,
    transparent 0%,
    rgba(255, 255, 255, 0.15) 45%,
    rgba(255, 255, 255, 0.3) 50%,
    rgba(255, 255, 255, 0.15) 55%,
    transparent 100%
  );
  transform: rotate(25deg) translateX(-150%);
  transition: transform 0.6s ease;
}

.shine-box:hover::after {
  transform: rotate(25deg) translateX(50%);
}`,
    html: `<div class="shine-box"></div>`,
  },
  {
    id: "hover-underline",
    name: "Animated Underline",
    description: "Text with an underline that animates in from the left on hover",
    category: "hover",
    css: `.hover-underline {
  font-size: 20px;
  font-weight: 600;
  color: #2c3e50;
  position: relative;
  cursor: pointer;
  text-decoration: none;
}

.hover-underline::after {
  content: '';
  position: absolute;
  bottom: -4px;
  left: 0;
  width: 0;
  height: 3px;
  background: linear-gradient(90deg, #667eea, #764ba2);
  border-radius: 2px;
  transition: width 0.3s ease;
}

.hover-underline:hover::after {
  width: 100%;
}`,
    html: `<span class="hover-underline">Hover over me</span>`,
  },
  {
    id: "hover-image-zoom",
    name: "Image Zoom Overlay",
    description: "Container that zooms its inner content and shows an overlay on hover",
    category: "hover",
    css: `.zoom-container {
  width: 140px;
  height: 100px;
  border-radius: 12px;
  overflow: hidden;
  position: relative;
  cursor: pointer;
  background: linear-gradient(135deg, #a29bfe, #6c5ce7);
}

.zoom-inner {
  width: 100%;
  height: 100%;
  background: linear-gradient(135deg, #a29bfe, #6c5ce7);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-weight: 600;
  transition: transform 0.4s ease;
}

.zoom-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-weight: 600;
  opacity: 0;
  transition: opacity 0.3s ease;
}

.zoom-container:hover .zoom-inner {
  transform: scale(1.1);
}

.zoom-container:hover .zoom-overlay {
  opacity: 1;
}`,
    html: `<div class="zoom-container">
  <div class="zoom-inner">Image</div>
  <div class="zoom-overlay">View</div>
</div>`,
  },

  // ===== TEXT EFFECTS =====
  {
    id: "text-gradient",
    name: "Gradient Text",
    description: "Text with a vibrant gradient color fill",
    category: "text",
    css: `.gradient-text {
  font-size: 36px;
  font-weight: 800;
  background: linear-gradient(135deg, #667eea, #764ba2, #f093fb);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}`,
    html: `<div class="gradient-text">Gradient</div>`,
  },
  {
    id: "text-glow",
    name: "Neon Glow Text",
    description: "Text with a neon glow effect simulating a neon sign",
    category: "text",
    css: `.neon-text {
  font-size: 32px;
  font-weight: 800;
  color: #fff;
  text-shadow:
    0 0 7px #fff,
    0 0 10px #fff,
    0 0 21px #fff,
    0 0 42px #0fa,
    0 0 82px #0fa,
    0 0 92px #0fa,
    0 0 102px #0fa,
    0 0 151px #0fa;
}`,
    html: `<div class="neon-text">NEON</div>`,
    previewBg: "#0a0a0a",
  },
  {
    id: "text-typewriter",
    name: "Typewriter Effect",
    description: "Text that types out character by character with a blinking cursor",
    category: "text",
    css: `.typewriter {
  font-size: 20px;
  font-weight: 600;
  font-family: monospace;
  overflow: hidden;
  white-space: nowrap;
  border-right: 3px solid #333;
  animation:
    typing 3.5s steps(12) infinite,
    blink-caret 0.75s step-end infinite;
}

@keyframes typing {
  0% { width: 0; }
  50% { width: 12ch; }
  60%, 100% { width: 12ch; }
}

@keyframes blink-caret {
  from, to { border-color: transparent; }
  50% { border-color: #333; }
}`,
    html: `<div class="typewriter">Hello World...</div>`,
  },
  {
    id: "text-stroke",
    name: "Outline / Stroke Text",
    description: "Text with only an outline stroke, no fill color",
    category: "text",
    css: `.stroke-text {
  font-size: 40px;
  font-weight: 800;
  color: transparent;
  -webkit-text-stroke: 2px #e74c3c;
}`,
    html: `<div class="stroke-text">OUTLINE</div>`,
  },
  {
    id: "text-animated-gradient",
    name: "Animated Gradient Text",
    description: "Text with a continuously moving gradient color animation",
    category: "text",
    css: `.anim-gradient-text {
  font-size: 32px;
  font-weight: 800;
  background: linear-gradient(
    90deg,
    #ff6b6b, #feca57, #48dbfb, #ff9ff3, #ff6b6b
  );
  background-size: 200% auto;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: text-shimmer 3s linear infinite;
}

@keyframes text-shimmer {
  to { background-position: 200% center; }
}`,
    html: `<div class="anim-gradient-text">Rainbow</div>`,
  },

  // ===== CARDS =====
  {
    id: "card-spotlight",
    name: "Spotlight Card",
    description: "Card with a radial spotlight that follows the mouse-like gradient",
    category: "cards",
    css: `.spotlight-card {
  width: 180px;
  height: 120px;
  border-radius: 16px;
  background: #1a1a2e;
  border: 1px solid rgba(255,255,255,0.1);
  padding: 20px;
  position: relative;
  overflow: hidden;
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  transition: border-color 0.3s;
}

.spotlight-card::before {
  content: '';
  position: absolute;
  width: 120px;
  height: 120px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(102,126,234,0.3), transparent 70%);
  top: -20px;
  right: -20px;
  transition: opacity 0.3s;
}

.spotlight-card:hover {
  border-color: rgba(102,126,234,0.4);
}

.spotlight-card:hover::before {
  opacity: 1;
  width: 200px;
  height: 200px;
}`,
    html: `<div class="spotlight-card">Spotlight</div>`,
    previewBg: "#0a0a1a",
  },
  {
    id: "card-hover-lift",
    name: "Hover Lift Card",
    description: "Card that lifts up with an enhanced shadow on hover",
    category: "cards",
    css: `.lift-card {
  width: 180px;
  height: 120px;
  border-radius: 16px;
  background: white;
  border: 1px solid #e2e8f0;
  padding: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  color: #2c3e50;
  transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
  cursor: pointer;
}

.lift-card:hover {
  transform: translateY(-8px);
  box-shadow:
    0 20px 40px rgba(0, 0, 0, 0.08),
    0 8px 16px rgba(0, 0, 0, 0.04);
}`,
    html: `<div class="lift-card">Hover Me</div>`,
  },
  {
    id: "card-color-shift",
    name: "Color Shift Border",
    description: "Card with a continuously color-shifting border",
    category: "cards",
    css: `.color-shift-card {
  width: 180px;
  height: 120px;
  border-radius: 16px;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  color: #333;
}

.color-shift-card::before {
  content: '';
  position: absolute;
  inset: -2px;
  border-radius: 18px;
  background: linear-gradient(
    var(--gradient-angle, 0deg),
    #ff6b6b, #feca57, #48dbfb, #ff9ff3
  );
  z-index: -1;
  animation: rotate-gradient 4s linear infinite;
}

.color-shift-card::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 16px;
  background: white;
  z-index: -1;
}

@property --gradient-angle {
  syntax: '<angle>';
  initial-value: 0deg;
  inherits: false;
}

@keyframes rotate-gradient {
  to { --gradient-angle: 360deg; }
}`,
    html: `<div class="color-shift-card">Color Shift</div>`,
  },

  // ===== LOADERS =====
  {
    id: "loader-spinner",
    name: "Classic Spinner",
    description: "A smooth rotating circular spinner loader",
    category: "loaders",
    css: `.spinner {
  width: 40px;
  height: 40px;
  border: 4px solid #e2e8f0;
  border-top-color: #667eea;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}`,
    html: `<div class="spinner"></div>`,
  },
  {
    id: "loader-dots",
    name: "Bouncing Dots",
    description: "Three dots that bounce in sequence",
    category: "loaders",
    css: `.dot-loader {
  display: flex;
  gap: 8px;
  align-items: center;
}

.dot-loader span {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #667eea;
  animation: dot-bounce 1.4s ease-in-out infinite;
}

.dot-loader span:nth-child(2) {
  animation-delay: 0.16s;
}

.dot-loader span:nth-child(3) {
  animation-delay: 0.32s;
}

@keyframes dot-bounce {
  0%, 80%, 100% {
    transform: scale(0.4);
    opacity: 0.4;
  }
  40% {
    transform: scale(1);
    opacity: 1;
  }
}`,
    html: `<div class="dot-loader">
  <span></span>
  <span></span>
  <span></span>
</div>`,
  },
  {
    id: "loader-pulse-ring",
    name: "Pulse Ring",
    description: "A pulsating ring that expands outward",
    category: "loaders",
    css: `.pulse-ring {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: #667eea;
  position: relative;
}

.pulse-ring::before {
  content: '';
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  border: 3px solid #667eea;
  animation: pulse-expand 1.5s ease-out infinite;
}

@keyframes pulse-expand {
  0% {
    transform: scale(1);
    opacity: 1;
  }
  100% {
    transform: scale(1.5);
    opacity: 0;
  }
}`,
    html: `<div class="pulse-ring"></div>`,
  },
  {
    id: "loader-bars",
    name: "Wave Bars",
    description: "Bars that animate in a wave pattern",
    category: "loaders",
    css: `.bar-loader {
  display: flex;
  gap: 4px;
  align-items: flex-end;
  height: 40px;
}

.bar-loader span {
  width: 6px;
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(180deg, #667eea, #764ba2);
  animation: bar-wave 1.2s ease-in-out infinite;
}

.bar-loader span:nth-child(1) { animation-delay: 0s; }
.bar-loader span:nth-child(2) { animation-delay: 0.1s; }
.bar-loader span:nth-child(3) { animation-delay: 0.2s; }
.bar-loader span:nth-child(4) { animation-delay: 0.3s; }
.bar-loader span:nth-child(5) { animation-delay: 0.4s; }

@keyframes bar-wave {
  0%, 40%, 100% {
    transform: scaleY(0.4);
  }
  20% {
    transform: scaleY(1);
  }
}`,
    html: `<div class="bar-loader">
  <span></span>
  <span></span>
  <span></span>
  <span></span>
  <span></span>
</div>`,
  },
  {
    id: "loader-orbit",
    name: "Orbit Loader",
    description: "A dot orbiting around a central point",
    category: "loaders",
    css: `.orbit-loader {
  width: 40px;
  height: 40px;
  position: relative;
  animation: orbit-spin 2s linear infinite;
}

.orbit-loader::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 2px solid rgba(102, 126, 234, 0.2);
}

.orbit-loader::after {
  content: '';
  position: absolute;
  top: 0;
  left: 50%;
  width: 8px;
  height: 8px;
  margin-left: -4px;
  border-radius: 50%;
  background: #667eea;
}

@keyframes orbit-spin {
  to { transform: rotate(360deg); }
}`,
    html: `<div class="orbit-loader"></div>`,
  },

  // ===== SHADOWS & BORDERS =====
  {
    id: "shadow-neumorphism",
    name: "Neumorphism",
    description: "Soft extruded shadow creating a neumorphic / soft UI appearance",
    category: "shadows",
    css: `.neumorphism {
  width: 120px;
  height: 80px;
  border-radius: 16px;
  background: #e0e5ec;
  box-shadow:
    8px 8px 16px #b8bec7,
    -8px -8px 16px #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  color: #555;
}`,
    html: `<div class="neumorphism">Soft UI</div>`,
    previewBg: "#e0e5ec",
  },
  {
    id: "shadow-inset-neumorph",
    name: "Inset Neumorphism",
    description: "Pressed / inset neumorphic element that appears sunken",
    category: "shadows",
    css: `.inset-neumorph {
  width: 120px;
  height: 80px;
  border-radius: 16px;
  background: #e0e5ec;
  box-shadow:
    inset 6px 6px 12px #b8bec7,
    inset -6px -6px 12px #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  color: #555;
}`,
    html: `<div class="inset-neumorph">Pressed</div>`,
    previewBg: "#e0e5ec",
  },
  {
    id: "shadow-multi-layer",
    name: "Multi-Layer Shadow",
    description: "Multiple layered shadows creating a depth effect",
    category: "shadows",
    css: `.multi-shadow {
  width: 120px;
  height: 80px;
  border-radius: 16px;
  background: white;
  box-shadow:
    0 1px 2px rgba(0,0,0,0.07),
    0 4px 8px rgba(0,0,0,0.07),
    0 16px 32px rgba(0,0,0,0.07);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  color: #2c3e50;
}`,
    html: `<div class="multi-shadow">Depth</div>`,
  },
  {
    id: "shadow-gradient-border",
    name: "Gradient Border",
    description: "Element with a gradient-colored border using the outline technique",
    category: "shadows",
    css: `.gradient-border {
  width: 120px;
  height: 80px;
  border-radius: 16px;
  background: white;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  color: #333;
  z-index: 1;
}

.gradient-border::before {
  content: '';
  position: absolute;
  inset: -3px;
  border-radius: 19px;
  background: linear-gradient(135deg, #667eea, #764ba2, #f093fb);
  z-index: -1;
}

.gradient-border::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 16px;
  background: white;
  z-index: -1;
}`,
    html: `<div class="gradient-border">Gradient</div>`,
  },
  {
    id: "shadow-dashed-animate",
    name: "Animated Dashed Border",
    description: "A dashed border that animates with a marching ants effect",
    category: "shadows",
    css: `.dashed-anim {
  width: 120px;
  height: 80px;
  border-radius: 16px;
  background: white;
  border: 3px dashed #667eea;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  color: #667eea;
  animation: march-ants 0.4s linear infinite;
}

@keyframes march-ants {
  to { border-dash-offset: 16px; }
}`,
    html: `<div class="dashed-anim">Dashed</div>`,
  },

  // ===== ANIMATIONS =====
  {
    id: "anim-float",
    name: "Floating",
    description: "Gentle up-and-down floating animation",
    category: "animations",
    css: `.floating {
  width: 60px;
  height: 60px;
  border-radius: 50%;
  background: linear-gradient(135deg, #667eea, #764ba2);
  animation: float 3s ease-in-out infinite;
}

@keyframes float {
  0%, 100% {
    transform: translateY(0px);
  }
  50% {
    transform: translateY(-15px);
  }
}`,
    html: `<div class="floating"></div>`,
  },
  {
    id: "anim-pulse",
    name: "Pulse",
    description: "Element that pulses in and out continuously",
    category: "animations",
    css: `.pulse-anim {
  width: 60px;
  height: 60px;
  border-radius: 50%;
  background: #e74c3c;
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(1.15);
    opacity: 0.7;
  }
}`,
    html: `<div class="pulse-anim"></div>`,
  },
  {
    id: "anim-shake",
    name: "Shake",
    description: "Rapid horizontal shaking animation for attention",
    category: "animations",
    css: `.shake-anim {
  width: 60px;
  height: 60px;
  border-radius: 12px;
  background: linear-gradient(135deg, #f39c12, #e74c3c);
  animation: shake 0.6s ease-in-out infinite;
}

@keyframes shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-5px); }
  75% { transform: translateX(5px); }
}`,
    html: `<div class="shake-anim"></div>`,
  },
  {
    id: "anim-morph",
    name: "Shape Morph",
    description: "Element that morphs between a square and circle",
    category: "animations",
    css: `.morph-anim {
  width: 60px;
  height: 60px;
  background: linear-gradient(135deg, #48dbfb, #0abde3);
  animation: morph 3s ease-in-out infinite;
}

@keyframes morph {
  0%, 100% {
    border-radius: 0;
    transform: rotate(0deg);
  }
  50% {
    border-radius: 50%;
    transform: rotate(180deg);
  }
}`,
    html: `<div class="morph-anim"></div>`,
  },
  {
    id: "anim-bounce-in",
    name: "Bounce In",
    description: "Element that bounces in from a scaled-down state",
    category: "animations",
    css: `.bounce-in {
  width: 60px;
  height: 60px;
  border-radius: 50%;
  background: linear-gradient(135deg, #BF5AF2, #7e2aac);
  animation: bounceIn 1s cubic-bezier(0.175, 0.885, 0.32, 1.275) infinite;
}

@keyframes bounceIn {
  0% {
    transform: scale(0);
    opacity: 0;
  }
  50% {
    transform: scale(1.1);
    opacity: 1;
  }
  70% {
    transform: scale(0.95);
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}`,
    html: `<div class="bounce-in"></div>`,
  },

  // ===== GRADIENTS =====
  {
    id: "gradient-mesh",
    name: "Mesh Gradient",
    description: "A mesh-like gradient using multiple radial gradients layered together",
    category: "gradients",
    css: `.mesh-gradient {
  width: 140px;
  height: 100px;
  border-radius: 16px;
  background:
    radial-gradient(at 20% 20%, #ff6b6b 0%, transparent 50%),
    radial-gradient(at 80% 20%, #48dbfb 0%, transparent 50%),
    radial-gradient(at 50% 80%, #feca57 0%, transparent 50%),
    linear-gradient(135deg, #667eea, #764ba2);
}`,
    html: `<div class="mesh-gradient"></div>`,
  },
  {
    id: "gradient-conic",
    name: "Conic Gradient",
    description: "A conic / angular gradient that sweeps around a center point",
    category: "gradients",
    css: `.conic-gradient {
  width: 100px;
  height: 100px;
  border-radius: 50%;
  background: conic-gradient(
    from 0deg,
    #ff6b6b, #feca57, #48dbfb, #ff9ff3, #ff6b6b
  );
}`,
    html: `<div class="conic-gradient"></div>`,
  },
  {
    id: "gradient-animated",
    name: "Animated Gradient Background",
    description: "A gradient background that shifts colors continuously",
    category: "gradients",
    css: `.animated-gradient {
  width: 140px;
  height: 100px;
  border-radius: 16px;
  background: linear-gradient(
    -45deg,
    #ee7752, #e73c7e, #23a6d5, #23d5ab
  );
  background-size: 400% 400%;
  animation: gradient-shift 4s ease infinite;
}

@keyframes gradient-shift {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}`,
    html: `<div class="animated-gradient"></div>`,
  },
  {
    id: "gradient-texture",
    name: "Gradient Texture",
    description: "A gradient with a subtle noise/grain texture overlay",
    category: "gradients",
    css: `.gradient-texture {
  width: 140px;
  height: 100px;
  border-radius: 16px;
  background: linear-gradient(135deg, #667eea, #764ba2);
  position: relative;
  overflow: hidden;
}

.gradient-texture::after {
  content: '';
  position: absolute;
  inset: 0;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E");
  opacity: 0.15;
  border-radius: 16px;
}`,
    html: `<div class="gradient-texture"></div>`,
  },

  // ===== GLASSMORPHISM =====
  {
    id: "glass-basic",
    name: "Glass Card",
    description: "A frosted glass card with blur and transparency",
    category: "glassmorphism",
    css: `.glass-card {
  width: 180px;
  height: 120px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.15);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.25);
  padding: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  color: white;
  text-shadow: 0 1px 2px rgba(0,0,0,0.2);
}`,
    html: `<div class="glass-card">Glass</div>`,
    previewBg: "linear-gradient(135deg, #667eea, #764ba2, #f093fb)",
  },
  {
    id: "glass-input",
    name: "Glass Input",
    description: "A text input with a frosted glass appearance",
    category: "glassmorphism",
    css: `.glass-input {
  width: 160px;
  padding: 10px 16px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  background: rgba(255, 255, 255, 0.15);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  color: white;
  font-size: 14px;
  outline: none;
  transition: border-color 0.3s;
}

.glass-input::placeholder {
  color: rgba(255, 255, 255, 0.6);
}

.glass-input:focus {
  border-color: rgba(255, 255, 255, 0.6);
}`,
    html: `<input class="glass-input" type="text" placeholder="Search...">`,
    previewBg: "linear-gradient(135deg, #2c3e50, #3498db)",
  },
  {
    id: "glass-nav",
    name: "Glass Navbar",
    description: "A navigation bar with a frosted glass background",
    category: "glassmorphism",
    css: `.glass-nav {
  width: 200px;
  padding: 10px 20px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid rgba(255, 255, 255, 0.2);
  display: flex;
  gap: 16px;
  justify-content: center;
}

.glass-nav span {
  color: white;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
  transition: background 0.2s;
}

.glass-nav span:hover {
  background: rgba(255, 255, 255, 0.15);
}`,
    html: `<nav class="glass-nav">
  <span>Home</span>
  <span>About</span>
  <span>Contact</span>
</nav>`,
    previewBg: "linear-gradient(135deg, #667eea, #764ba2)",
  },
  {
    id: "glass-icon-btn",
    name: "Glass Icon Button",
    description: "Circular icon button with a glass effect",
    category: "glassmorphism",
    css: `.glass-icon-btn {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.15);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.25);
  color: white;
  font-size: 18px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.glass-icon-btn:hover {
  background: rgba(255, 255, 255, 0.25);
  transform: scale(1.05);
}`,
    html: `<button class="glass-icon-btn">♥</button>`,
    previewBg: "linear-gradient(135deg, #e74c3c, #c0392b)",
  },
];
