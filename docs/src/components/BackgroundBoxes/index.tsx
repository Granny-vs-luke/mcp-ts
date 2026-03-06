import React from 'react';
import styles from './styles.module.css';

const particles = Array.from({ length: 18 }, (_, index) => ({
  id: index,
  left: `${6 + ((index * 11) % 82)}%`,
  top: `${8 + ((index * 7) % 68)}%`,
  duration: `${16 + (index % 5) * 3}s`,
  delay: `${(index % 6) * 0.8}s`,
}));

export const Boxes = () => {
  return (
    <div className={styles.background} aria-hidden="true">
      <div className={styles.grid} />
      {particles.map((particle) => (
        <span
          key={particle.id}
          className={styles.particle}
          style={{
            left: particle.left,
            top: particle.top,
            animationDuration: particle.duration,
            animationDelay: particle.delay,
          }}
        />
      ))}
    </div>
  );
};
