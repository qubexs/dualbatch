# Dual Meta to Flow

Chrome extension (Vite + React TSX + CRXJS). One-click: meta.ai image → labs.google.com/flow video.

## Dev
1. `npm install`
2. `npm run dev` (popup HMR) or `npm run build` → `dist/`
3. `chrome://extensions` → Developer mode → Load unpacked → select `dist/`
4. Log in to https://www.meta.ai and https://labs.google.com/flow first.
5. Open popup → Start pipeline. Keep both tabs open.

## Settings
Model: omni 1.1 flash (default), veo 3.1 fast/lite/quality. Time: 4s/6s/8s. Aspect: 16:9/9:16/1:1. Size: 720p/1080p.
Omni flash auto-clamps to max 6s / 720p.

## Notes
- DOM selectors live in `src/shared/selectors.ts` — both sites change markup often.
- Image transfer passes URL string; Flow tab fetches it directly.
