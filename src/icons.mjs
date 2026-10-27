import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Monitor } from 'lucide-react';

export function remoteSessionIcon(theme = 'light') {
  const dark = theme === 'dark';
  return renderToStaticMarkup(createElement('svg', {
    xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 24 24', width: 24, height: 24,
  },
  createElement(Monitor, { x: 7, y: 0, width: 17, height: 17, strokeWidth: 1.9, color: dark ? '#74d5c5' : '#177e70' }),
  createElement(Monitor, { x: 0, y: 7, width: 17, height: 17, strokeWidth: 1.9, color: dark ? '#f0f1f2' : '#343a40', fill: dark ? '#202123' : '#ffffff' })));
}

export const remoteSessionIcons = ['light', 'dark'].map((theme) => ({
  src: `data:image/svg+xml;base64,${Buffer.from(remoteSessionIcon(theme)).toString('base64')}`,
  mimeType: 'image/svg+xml', sizes: ['any'], theme,
}));
