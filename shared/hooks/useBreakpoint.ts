import { useEffect, useState } from "react";

/** Breakpoints: mobile < 640, tablet 640–1023, desktop >= 1024 */
export function useBreakpoint() {
  const [width, setWidth] = useState(1280); // SSR-safe desktop default

  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return {
    isMobile: width < 640,
    isTablet: width >= 640 && width < 1024,
    isDesktop: width >= 1024,
    isMobileOrTablet: width < 1024,
    width,
  };
}
