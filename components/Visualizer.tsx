
import React from 'react';

interface VisualizerProps {
  volume: number; // 0 to 1
  isActive: boolean;
  color: string;
}

const Visualizer: React.FC<VisualizerProps> = ({ volume, isActive, color }) => {
  const intensity = isActive ? Math.max(0.02, volume * 2.5) : 0;
  const scale = 1 + intensity * 0.5;
  
  // Create a shifting color effect based on intensity
  const glowColor = isActive ? (volume > 0.4 ? '#22d3ee' : (volume > 0.1 ? '#3b82f6' : color)) : '#1e293b';

  return (
    <div className="relative flex items-center justify-center w-full aspect-square max-w-[420px] mx-auto overflow-visible">
      {/* Dynamic Background Atmosphere */}
      <div 
        className="absolute inset-0 rounded-full blur-[120px] transition-all duration-700 opacity-25"
        style={{ 
          backgroundColor: glowColor,
          transform: `scale(${scale * 1.3})`,
        }}
      />
      
      <svg viewBox="0 0 200 200" className="w-full h-full relative z-10 overflow-visible filter drop-shadow-[0_0_20px_rgba(34,211,238,0.2)]">
        <defs>
          <filter id="supra-plasma-filter">
            <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
            <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 30 -14" result="goo" />
            <feBlend in="SourceGraphic" in2="goo" />
          </filter>
          
          <radialGradient id="plasmaGrad" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="white" stopOpacity="0.9" />
            <stop offset="30%" stopColor={glowColor} stopOpacity="0.7" />
            <stop offset="100%" stopColor={glowColor} stopOpacity="0" />
          </radialGradient>

          <filter id="inner-glow">
            <feFlood floodColor="white" floodOpacity="0.5" result="glowColor" />
            <feComposite in="glowColor" in2="SourceGraphic" operator="in" result="glow" />
            <feGaussianBlur in="glow" stdDeviation="2" result="softGlow" />
            <feMerge>
              <feMergeNode in="softGlow" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <g filter="url(#supra-plasma-filter)">
          {/* Reactive Plasma Field */}
          {[...Array(8)].map((_, i) => (
            <circle
              key={i}
              cx="100"
              cy="100"
              r={45 + (intensity * 65)}
              fill="url(#plasmaGrad)"
              className="transition-all duration-[400ms] ease-out opacity-70"
              style={{
                transformOrigin: 'center',
                transform: `
                  translate(
                    ${Math.sin(Date.now()/500 + i * 1.5) * (20 * intensity)}px, 
                    ${Math.cos(Date.now()/600 + i * 1.2) * (20 * intensity)}px
                  ) 
                  scale(${1 + Math.sin(Date.now()/400 + i) * 0.15 * intensity})
                `,
              }}
            />
          ))}

          {/* Core Nucleus */}
          <circle
            cx="100"
            cy="100"
            r={isActive ? 38 + (intensity * 15) : 32}
            fill={isActive ? '#ffffff' : '#334155'}
            filter="url(#inner-glow)"
            className="transition-all duration-300 shadow-inner"
            style={{
              opacity: isActive ? 0.9 : 0.3,
            }}
          />
        </g>

        {/* Neural Synchronization Rings */}
        {[...Array(2)].map((_, i) => (
          <circle
            key={`ring-${i}`}
            cx="100"
            cy="100"
            r={85 + (i * 20) + (intensity * 25)}
            fill="none"
            stroke={glowColor}
            strokeWidth="0.75"
            strokeDasharray={i === 0 ? "2, 10" : "5, 15"}
            className={`opacity-20 ${isActive ? 'animate-spin' : ''}`}
            style={{ 
              animationDuration: `${4 + i * 3}s`,
              animationDirection: i % 2 === 0 ? 'normal' : 'reverse',
              filter: 'blur(1px)'
            }}
          />
        ))}
      </svg>
      
      {/* HUD Scanner Lines */}
      <div className={`absolute inset-0 border-[1px] rounded-full border-cyan-500/10 transition-all duration-[2000ms] ${isActive ? 'scale-[1.35] opacity-100 rotate-90' : 'scale-100 opacity-0'}`} />
      <div className={`absolute inset-0 border-[0.5px] rounded-full border-blue-500/20 transition-all duration-[1500ms] ${isActive ? 'scale-[1.15] opacity-50 -rotate-90' : 'scale-90 opacity-0'}`} />
    </div>
  );
};

export default Visualizer;
