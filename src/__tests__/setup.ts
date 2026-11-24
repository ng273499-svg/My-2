import '@testing-library/jest-dom/vitest';

// Mock scrollIntoView in jsdom
if (typeof window !== 'undefined' && window.HTMLElement) {
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
}
