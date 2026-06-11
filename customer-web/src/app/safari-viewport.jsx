'use client';

import { useEffect } from 'react';

export default function SafariViewport() {
  useEffect(() => {
    const apply = () => {
      const height = window.visualViewport?.height || window.innerHeight;
      document.documentElement.style.setProperty('--app-height', `${height}px`);
    };
    apply();
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
    window.addEventListener('pageshow', apply);
    window.visualViewport?.addEventListener('resize', apply);
    return () => {
      window.removeEventListener('resize', apply);
      window.removeEventListener('orientationchange', apply);
      window.removeEventListener('pageshow', apply);
      window.visualViewport?.removeEventListener('resize', apply);
    };
  }, []);

  return null;
}
